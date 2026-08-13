import path from 'node:path';
import vscode from 'vscode';
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  State,
  type ErrorHandler,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';
import { RSTACK_CONFIG_GLOB } from '../../detection';
import { getConfiguredNodeExecutable } from '../../shared/nodeExecutableSetting';
import {
  configuredNodeBelowFloor,
  NODE_EXECUTABLE_SETTING,
  NodePreflightError,
  resolveUserNodeOnce,
} from '../../shared/nodeResolution';
import {
  findPackageJsonUncached,
  readPackageJson,
} from '../../shared/packageResolve';
import {
  checkPackageVersion,
  formatVersionMismatch,
} from '../../shared/versionCheck';
import type {
  DetectionSnapshot,
  StackContext,
  StackController,
} from '../../types';
// `LanguageServerProcessOwner` lives under `stacks/lint` because that is where
// it was first needed, but nothing in it is lint-specific: it owns the native
// children of one language client, including the ones vscode-languageclient's
// automatic restart creates. Importing it is not a refactor across the stacks —
// no lint behaviour is shared, and the file has no lint imports.
import { LanguageServerProcessOwner } from '../lint/LanguageServerProcessOwner';
import { pickBinEntry } from './binEntry';
import {
  foldFolderStatus,
  type FmtFolderStatus,
  type FmtRuntimeState,
} from './status';

// prettier 3.9.6 getSupportInfo() vscodeLanguageIds snapshot (rs fmt's pinned
// prettier). Revisit when the pinned prettier changes.
const LANGUAGE_IDS = [
  'ansible',
  'css',
  'dockercompose',
  'github-actions-workflow',
  'graphql',
  'handlebars',
  'home-assistant',
  'html',
  'javascript',
  'javascriptreact',
  'json',
  'json5',
  'jsonc',
  'less',
  'markdown',
  'mdx',
  'mjml',
  'mongo',
  'postcss',
  'scss',
  'typescript',
  'typescriptreact',
  'vue',
  'yaml',
] as const;

/**
 * The document selector of one folder's server: the 24 languages `rs fmt` can
 * parse, each confined to that folder. The per-folder pattern is what keeps two
 * servers in a multi-root window from both claiming a document — the same rule
 * (and the same `RelativePattern`) the lint stack applies in
 * `createWorkspaceDocumentSelector`.
 */
const createFolderDocumentSelector = (
  folder: vscode.WorkspaceFolder,
): vscode.DocumentFilter[] => {
  const pattern = new vscode.RelativePattern(folder, '**/*');
  return LANGUAGE_IDS.map((language) => ({
    scheme: 'file',
    language,
    pattern,
  }));
};

/**
 * How long a folder's config events settle before its server restarts. The
 * same window detection uses to coalesce a redetect burst.
 */
const CONFIG_RESTART_DEBOUNCE_MS = 300;

/** True when `filePath` is inside `dir` (or is `dir` itself). */
const contains = (dir: string, filePath: string): boolean => {
  const relative = path.relative(path.resolve(dir), path.resolve(filePath));
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

/**
 * vscode-languageclient calls `stop()` without observing its promise when an
 * initialize request fails, and its base `stop` rejects for non-Running states.
 * The process owner handles those states, so only that inactive case is
 * normalized. (The lint stack carries the same class as `ManagedLanguageClient`;
 * it is restated here rather than imported so the two stacks share no runtime.)
 */
class FmtLanguageClient extends LanguageClient {
  public override async stop(timeout?: number): Promise<void> {
    const stateBeforeStop = this.state;
    try {
      await super.stop(timeout);
    } catch (error) {
      if (stateBeforeStop === State.Running) {
        throw error;
      }
    }
  }
}

/**
 * One `rs fmt --lsp` language server, spawned with cwd = the workspace folder
 * root and told that folder is its workspace.
 *
 * The folder root — not the deepest directory holding an `rstack.config.*` — is
 * the anchor because `rs fmt` loads exactly one config, from its cwd, with no
 * upward walk and no merging. Anchoring deeper made the editor format a file
 * differently from `rs fmt` run at the repo root, which is where the config the
 * project actually documents lives. The server caches that config for its
 * process lifetime, so a config edit is a restart of this runtime, never a
 * message to a live server.
 */
class FmtFolderRuntime {
  #state: FmtRuntimeState = 'stopped';
  /** See {@link FmtFolderStatus.detail} — folder-agnostic, the fold prefixes. */
  #detail = '';
  /** See {@link FmtFolderStatus.advisory}. */
  #advisory: string | undefined;
  #owner: LanguageServerProcessOwner | undefined;
  #client: LanguageClient | undefined;
  #defaultErrorHandler: ErrorHandler | undefined;
  #stateWatcher: vscode.Disposable | undefined;
  #closing = false;
  #disposed = false;
  /**
   * Every lifecycle transition of one folder runs here, so a config event
   * arriving mid-start cannot interleave a second start with the first.
   */
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly folder: vscode.WorkspaceFolder,
    private readonly context: StackContext,
    /**
     * Called on every {@link folderStatus} change. The runtime never reports
     * to the shell itself — the controller folds all folder statuses into the
     * stack's one report (`foldFolderStatus`).
     */
    private readonly onDidChangeStatus: () => void,
  ) {}

  get state(): FmtRuntimeState {
    return this.#state;
  }

  /** This folder's contribution to the stack status (see `status.ts`). */
  get folderStatus(): FmtFolderStatus {
    return {
      name: this.folder.name,
      state: this.#state,
      detail: this.#detail,
      advisory: this.#advisory,
    };
  }

  get folderPath(): string {
    return this.folder.uri.fsPath;
  }

  private setState(state: FmtRuntimeState, detail = ''): void {
    this.#state = state;
    this.#detail = detail;
    this.onDidChangeStatus();
  }

  private setAdvisory(message: string): void {
    this.#advisory = message;
    this.onDidChangeStatus();
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.#disposed) {
        return;
      }
      await this.startImpl();
    });
  }

  /** A config change invalidates the server's cached config; only a new process clears it. */
  restart(reason: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.#disposed) {
        return;
      }
      this.context.output.info(
        `Restarting the rs fmt server for ${this.folder.name}: ${reason}`,
      );
      await this.stopImpl();
      if (this.#disposed) {
        return;
      }
      await this.startImpl();
    });
  }

  stop(): Promise<void> {
    this.#disposed = true;
    return this.enqueue(async () => {
      await this.stopImpl();
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.catch((error: unknown) => {
      this.context.output.error(
        `rs fmt lifecycle step failed in ${this.folder.name}`,
        error,
      );
    });
    return this.#queue;
  }

  /**
   * Package resolution, version check, Node selection and client start, in that
   * order. Every failure short of a genuine launch failure is a state the
   * controller reports: the stack owns no UI chrome, and a project without
   * `rstack` installed is not a crash.
   */
  private async startImpl(): Promise<void> {
    const context = this.context;
    const folderRoot = this.folder.uri.fsPath;
    this.#closing = false;
    this.setState('starting');

    const pkgJsonPath = findPackageJsonUncached('rstack', folderRoot);
    if (!pkgJsonPath) {
      this.setState(
        'disabled',
        'rstack is not installed (node_modules missing)',
      );
      context.output.warn(
        `rstack is not installed in ${this.folder.name} (node_modules missing); searched from ${folderRoot}`,
      );
      return;
    }

    // One read for the version and the bin entry; `readPackageJson` re-reads
    // from disk by design, so a reinstall is picked up on the next start.
    const pkg = readPackageJson(pkgJsonPath);
    const version = typeof pkg?.version === 'string' ? pkg.version : undefined;
    const versionCheck = checkPackageVersion('rstack', version);
    if (versionCheck.kind === 'mismatch') {
      this.setState(
        'version-mismatch',
        formatVersionMismatch('rstack', versionCheck),
      );
      return;
    }
    const rsBinJs = path.resolve(
      path.dirname(pkgJsonPath),
      pickBinEntry(pkg?.bin),
    );

    const nodeExecutable = await this.resolveNodeExecutable();
    if (nodeExecutable === undefined || this.#disposed) {
      return;
    }

    const owner = new LanguageServerProcessOwner(
      nodeExecutable,
      [rsBinJs, 'fmt', '--lsp'],
      folderRoot,
    );
    this.#owner = owner;
    const serverOptions: ServerOptions = async () => owner.start();
    const client = new FmtLanguageClient(
      'rstack-fmt',
      `rs fmt Language Server (${this.folder.name})`,
      serverOptions,
      this.createClientOptions(),
    );
    // Created once per client, not per callback: the default handler carries
    // the restart budget (N crashes in K minutes), and it can only be created
    // from the client the options were built for.
    this.#defaultErrorHandler = client.createDefaultErrorHandler();
    this.#client = client;
    this.#stateWatcher = client.onDidChangeState((event) => {
      if (this.#closing || this.#disposed || client !== this.#client) {
        return;
      }
      if (event.newState === State.Stopped) {
        // Whether a restart follows is the error handler's and the process
        // owner's call; either way this folder is currently not formatting.
        this.setState('crashed', 'the rs fmt language server stopped');
      } else if (event.newState === State.Running) {
        // The one writer for `running`. It fires on the first start
        // (synchronously, before `client.start()` resolves) and again when
        // vscode-languageclient's error handler restarts a crashed server —
        // the way back out of `crashed`, the same transition the lint stack's
        // state watcher makes.
        this.setState('running');
      }
    });

    context.output.debug(
      `Starting rs fmt --lsp in ${folderRoot}: ${nodeExecutable} ${rsBinJs}`,
    );
    try {
      // The client registers the formatting provider from the server's
      // `documentFormattingProvider` capability — the stack registers none of
      // its own. The state watcher above is what records the successful start:
      // the client reaches `State.Running` before this await resolves.
      await client.start();
    } catch (error) {
      // Teardown first: `stopImpl` ends in the `stopped` state, so the
      // `crashed` verdict has to be written after it, not raced against it.
      await this.stopImpl();
      this.setState(
        'crashed',
        `the rs fmt language server failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      context.output.error('Failed to start the rs fmt language server', error);
      return;
    }
    context.output.info(`rs fmt language server started for ${folderRoot}`);
  }

  /**
   * The User Node runtime this folder's server runs on, or `undefined` when no
   * candidate cleared the floor (already reported as `version mismatch`).
   *
   * The server loads the project's `rstack.config.*` through
   * `@rstackjs/load-config` with `loader: 'native'`, which is the exact path the
   * uniform floor exists for — so fmt takes the same runtime decision as the
   * rstest worker, out of the same shared module.
   */
  private async resolveNodeExecutable(): Promise<string | undefined> {
    const context = this.context;
    const configured = getConfiguredNodeExecutable(this.folder);
    if (configured !== undefined) {
      // An explicit pin is always honoured — it is the escape hatch — but it is
      // still probed, advisory-only, off the start path.
      void configuredNodeBelowFloor(configured).then((message) => {
        if (message !== undefined && !this.#disposed) {
          this.setAdvisory(message);
        }
      });
      return configured;
    }
    try {
      const resolution = await resolveUserNodeOnce({
        shell: vscode.env.shell || undefined,
        cwd: this.folderPath,
        notify: (message) => {
          context.output.info(message);
        },
      });
      return resolution.executable;
    } catch (error) {
      if (error instanceof NodePreflightError) {
        this.setState(
          'version-mismatch',
          error.messageWith('rs fmt will not format'),
        );
        return undefined;
      }
      throw error;
    }
  }

  /**
   * The error handler delegates through `#defaultErrorHandler` because the
   * default handler can only be created from the client that will use it,
   * which does not exist yet when the options are built.
   */
  private createClientOptions(): LanguageClientOptions {
    const documentSelector = createFolderDocumentSelector(this.folder);
    const errorHandler: ErrorHandler = {
      error: async (error, message, count) =>
        Promise.resolve(
          this.#defaultErrorHandler?.error(error, message, count) ?? {
            action: ErrorAction.Shutdown,
          },
        ),
      closed: async () => {
        if (this.#closing || this.#disposed) {
          return { action: CloseAction.DoNotRestart, handled: true };
        }
        return Promise.resolve(
          this.#defaultErrorHandler?.closed() ?? {
            action: CloseAction.DoNotRestart,
          },
        );
      },
    };
    return {
      workspaceFolder: this.folder,
      // languageclient v9 types this client-only selector as the LSP shape,
      // whose pattern is string-only. Its converter forwards the pattern to
      // VS Code's DocumentFilter, which supports RelativePattern and preserves
      // an unambiguous workspace base even when the path contains glob syntax.
      documentSelector:
        // rslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        documentSelector as unknown as LanguageClientOptions['documentSelector'],
      outputChannel: this.context.output,
      errorHandler,
    };
  }

  private async stopImpl(): Promise<void> {
    const client = this.#client;
    const owner = this.#owner;
    this.#client = undefined;
    this.#owner = undefined;
    this.#closing = true;
    this.#stateWatcher?.dispose();
    this.#stateWatcher = undefined;
    // Block vscode-languageclient's automatic restart callback before the
    // graceful shutdown begins; the owner force-terminates whatever survives.
    owner?.beginClose();
    if (client) {
      try {
        await client.dispose();
      } catch (error) {
        this.context.output.debug(
          `Disposing the rs fmt language client for ${this.folder.name} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    try {
      await owner?.close();
    } catch (error) {
      this.context.output.error(
        `Failed to stop the rs fmt language server for ${this.folder.name}`,
        error,
      );
    }
    // A stop retires this start's advisory with it: a restart re-probes the
    // (memoized) pin verdict, and a changed pin rebuilds the controller anyway.
    this.#advisory = undefined;
    this.setState('stopped');
  }
}

/**
 * The fmt stack: one `rs fmt --lsp` language server per detected workspace
 * folder, each rooted at its folder.
 *
 * The controller owns no formatting provider of its own — every server declares
 * `documentFormattingProvider`, and its client registers the provider for that
 * folder's documents. What the controller owns is the folder set: detection
 * decides which folders have a server, and an `rstack.config.*` event restarts
 * the one whose folder holds the file.
 */
class FmtController implements StackController {
  readonly id = 'fmt' as const;
  /**
   * The Node runtime is chosen once per server start, so a changed pin can only
   * reach a live server through a rebuild of this controller.
   */
  readonly restartOnSettings = [NODE_EXECUTABLE_SETTING];

  #context: StackContext | undefined;
  /** The newest detection result, which `running` reports the reason from. */
  #snapshot: DetectionSnapshot | undefined;
  readonly #runtimes = new Map<string, FmtFolderRuntime>();
  /** Per-folder config-event debounce (see `register`'s `onConfigEvent`). */
  readonly #restartTimers = new Map<string, NodeJS.Timeout>();
  readonly #subscriptions: vscode.Disposable[] = [];
  #disposed = false;

  register(context: StackContext): Promise<Record<string, unknown>> {
    this.#context = context;
    this.#snapshot = context.detection;
    // Detection cannot stand in for this watcher: its signature records only
    // which config files exist, so it misses a content edit, and it misses the
    // delete/create pair an atomic save produces for one unchanged path.
    const configWatcher =
      vscode.workspace.createFileSystemWatcher(RSTACK_CONFIG_GLOB);
    const onConfigEvent = (uri: vscode.Uri): void => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      // Only the folder root's config can be the one the server read — it
      // loads exactly one config, from its cwd, with no upward walk — so an
      // `rstack.config.*` event deeper in the tree must not cost a restart.
      if (!folder || path.dirname(uri.fsPath) !== folder.uri.fsPath) {
        return;
      }
      const folderPath = folder.uri.fsPath;
      if (!this.#runtimes.has(folderPath)) {
        return;
      }
      // An atomic save arrives as a delete/create pair and an editor can save
      // in bursts; a short debounce folds them into one restart (same window
      // as detection's redetect debounce).
      clearTimeout(this.#restartTimers.get(folderPath));
      this.#restartTimers.set(
        folderPath,
        setTimeout(() => {
          this.#restartTimers.delete(folderPath);
          void this.#runtimes.get(folderPath)?.restart(`${uri.fsPath} changed`);
        }, CONFIG_RESTART_DEBOUNCE_MS),
      );
    };
    this.#subscriptions.push(
      context.onDidChangeDetection((snapshot) => {
        this.#snapshot = snapshot;
        this.reconcile();
        // The shell's reconcile leaves a still-detected controller alone, so
        // the running reason must follow the new snapshot here.
        this.reportStatus();
      }),
      configWatcher,
      configWatcher.onDidCreate(onConfigEvent),
      configWatcher.onDidChange(onConfigEvent),
      configWatcher.onDidDelete(onConfigEvent),
    );
    this.reportStatus();
    // Starting a server spawns a process; `register()` must return fast, so the
    // folder set is reconciled without awaiting any start.
    this.reconcile();
    return Promise.resolve({
      languages: LANGUAGE_IDS,
      /**
       * E2E only: whether a *running* server covers this path — the folder's
       * server has started and the path lies inside that folder. It answers by
       * folder, not by language: what it exists to distinguish is a folder with
       * a live server from one without.
       */
      formats: (fsPath: string): boolean =>
        [...this.#runtimes.values()].some(
          (runtime) =>
            runtime.state === 'running' && contains(runtime.folderPath, fsPath),
        ),
      /** E2E only: every folder runtime's lifecycle state, keyed by folder path. */
      folderStates: (): Record<string, string> =>
        Object.fromEntries(
          [...this.#runtimes].map(([folderPath, runtime]) => [
            folderPath,
            runtime.state,
          ]),
        ),
    });
  }

  /**
   * Brings the folder set in line with detection: a newly detected folder gets
   * a server, an undetected one loses it, and a folder that is in both sets is
   * left alone — restarting a healthy server on an unrelated folder's detection
   * change would drop its cached config for nothing.
   */
  private reconcile(): void {
    const context = this.#context;
    const snapshot = this.#snapshot;
    if (!context || !snapshot || this.#disposed) {
      return;
    }
    const detected = new Map(
      snapshot
        .foldersFor('fmt')
        .map((entry) => [entry.folder.uri.fsPath, entry.folder] as const),
    );
    for (const [folderPath, runtime] of [...this.#runtimes]) {
      if (!detected.has(folderPath)) {
        this.#runtimes.delete(folderPath);
        void runtime.stop();
      }
    }
    for (const [folderPath, folder] of detected) {
      if (this.#runtimes.has(folderPath)) {
        continue;
      }
      // The callback re-reads `#snapshot`, so a server that finishes starting
      // after a detection change reports from the freshest snapshot — and the
      // closure captures nothing beyond `this`.
      const runtime = new FmtFolderRuntime(folder, context, () =>
        this.reportStatus(),
      );
      this.#runtimes.set(folderPath, runtime);
      void runtime.start();
    }
  }

  /**
   * The one writer to the shell's status: the whole folder set folded into a
   * single report (`foldFolderStatus` — severity, multi-root prefixes and the
   * healthy-sibling-never-masks-a-failure invariant all live there, where they
   * are unit-testable).
   */
  private reportStatus(): void {
    const context = this.#context;
    const snapshot = this.#snapshot;
    if (!context || !snapshot || this.#disposed) {
      return;
    }
    const names = snapshot.foldersFor('fmt').map((entry) => entry.folder.name);
    if (names.length === 0) {
      // Nothing detected means the shell is about to retire this controller;
      // its gate state, not a fold over runtimes, is the truthful report.
      return;
    }
    context.status.report(
      foldFolderStatus(
        [...this.#runtimes.values()].map((runtime) => runtime.folderStatus),
        names.length <= 3
          ? `detected in ${names.join(', ')}`
          : `detected in ${names.length} folders`,
      ),
    );
  }

  /**
   * Covers `rstack.fmt.restart` (the shell rebuilds the controller), a folder
   * losing detection and a workspace losing its trust: none of them may leave a
   * server process behind, so the teardown is awaited.
   */
  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const timer of this.#restartTimers.values()) {
      clearTimeout(timer);
    }
    this.#restartTimers.clear();
    for (const subscription of this.#subscriptions.splice(0)) {
      subscription.dispose();
    }
    const runtimes = [...this.#runtimes.values()];
    this.#runtimes.clear();
    await Promise.allSettled(runtimes.map(async (runtime) => runtime.stop()));
    // The User Node preflight memo is deliberately not reset here: it is
    // host-scoped state shared with the rstest stack, and the shell's restart
    // pass owns the reset (see `runRestart`).
    this.#context = undefined;
    this.#snapshot = undefined;
  }
}

export const createFmtController = (): StackController => new FmtController();
