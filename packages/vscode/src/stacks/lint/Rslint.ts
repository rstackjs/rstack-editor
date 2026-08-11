// Copied from web-infra-dev/rslint `packages/vscode-extension/src/Rslint.ts`
// (origin/main). This is the most heavily adapted file of the port;
// every divergence from upstream is one of:
//
// 1. the shell-activation adaptation — nothing here creates a status bar item,
//    registers a command or activates the extension; the shell owns the
//    lifecycle and this class is a per-workspace-folder runtime driven by
//    `WorkspaceRslintCoordinator`.
// 2. the namespace adaptation — every setting is read from `rstack.rslint.*`.
// 3. the resolve-from-project adaptation — the `built-in` binary mode is gone,
//    the binary/config-loader/eslint-plugin all come from one project
//    resolution root (`resolution.ts`), and `@rslint/core/config-loader`
//    contributes types only at compile time; `CONFIG_DISCOVERY_PROTOCOL_VERSION`
//    and `ConfigModuleHost` are injected from the project-resolved module.
// 4. the status-aggregation adaptation — `reportStatus` instead of an own
//    status bar.
// 5. watch glob — `CONFIG_REFRESH_WATCH_GLOB` kept verbatim; bridged folders
//    install `BRIDGED_CONFIG_REFRESH_WATCH_GLOB` instead.
// 6. the Rstack config bridge — everything between a
//    `--- rstack config bridge ---` marker pair. A *bridged folder* (no native
//    `rslint.config.*` anywhere, an `rstack.config.*` at the folder root) gets
//    a *generated shim* written into the project, and the language server is
//    pinned to it through the optional `configPath` field of
//    `rslint/configRefresh` (config-discovery protocol >= 2, rslint PR #1630).
//    The choice is fixed for the server process lifetime: the same value on
//    every refresh, and a mode flip is a restart, not a message. Native mode is
//    byte-identical to upstream — the `configPath` key is absent entirely, so
//    the server keeps doing automatic discovery. The rule, the shim and the
//    capability gate live in `rstackBridge.ts`; this file only wires them.
//
// Plus the three compatibility diagnostics: the config-discovery protocol
// handshake, the jiti preflight, and the rstack-loader preflight.

import {
  workspace,
  Uri,
  Disposable,
  FileSystemWatcher,
  RelativePattern,
  WorkspaceFolder,
  OutputChannel,
  TextDocument,
  type CancellationToken,
} from 'vscode';
import {
  CloseAction,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ErrorAction,
  LanguageClient,
  LanguageClientOptions,
  type ErrorHandler,
  type Middleware,
  ServerOptions,
  State,
  Trace,
} from 'vscode-languageclient/node';
import type { Logger } from './logger';
import path from 'node:path';
import fs from 'node:fs';
import type {
  ActivateConfigsRequest,
  ConfigModuleActivationPlan,
  LoadConfigsRequest,
} from '@rslint/core/config-loader';
import { PluginLintPool } from './PluginLintPool';
import type {
  ConfigDescriptor,
  EslintPluginLintRequest,
  PluginLintHost,
} from '@rslint/core/eslint-plugin';
import {
  ConfigTransactionProtocolMismatchError,
  LspConfigTransactionAdapter,
  type ConfigTransactionControlRequest,
} from './ConfigTransactionAdapter';
import {
  createWorkspaceDocumentSelector,
  type WorkspaceDocumentRouter,
} from './WorkspaceDocumentRouter';
import { LanguageServerProcessOwner } from './LanguageServerProcessOwner';
import type { StackState } from '../../types';
import {
  checkPackageVersion,
  formatVersionMismatch,
} from '../../shared/versionCheck';
import {
  ConfigDiscoveryProtocolMismatchError,
  loadConfigLoaderModule,
  loadEslintPluginModule,
  type ConfigLoaderModule,
} from './configLoader';
import {
  RslintResolutionError,
  resolveRslint,
  type RslintResolution,
} from './resolution';
import {
  describeJitiPreflight,
  isJitiMissingError,
  JITI_INSTALL_HINT,
} from './jitiPreflight';
// --- rstack config bridge ---
import { nativeTypeStrippingAvailable } from '../../shared/vendored/loadRstackConfig';
import {
  decideLintConfigMode,
  describeRstackConfigLoaderPreflight,
  formatBridgeProtocolGate,
  formatBridgeToolchainGap,
  removeGeneratedShim,
  resolveRstackConfigLoader,
  RSTACK_CONFIG_PROBE_ORDER,
  RstackBridgeGateError,
  supportsExplicitConfigPath,
  writeGeneratedShim,
  type GeneratedShim,
  type LintConfigMode,
} from './rstackBridge';
// --- end rstack config bridge ---
/**
 * Workspace-relative lockfiles whose individual metadata feeds the
 * plugin-host fingerprint. A dependency install can swap a plugin's
 * implementation without touching the config file, so the host must rebuild.
 */
const LOCKFILE_NAMES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
] as const;

/**
 * Kept verbatim from upstream, JSON names included: they are not detection
 * signals but watching them is harmless, and the Go server does
 * load `rslint.json` from its cwd as a no-JS-config fallback.
 */
const RSLINT_CONFIG_WATCH_NAMES = [
  'rslint.config.js',
  'rslint.config.mjs',
  'rslint.config.ts',
  'rslint.config.mts',
  'rslint.json',
  'rslint.jsonc',
] as const;

// Upstream's glob, kept verbatim: this is what a native-mode folder watches.
export const CONFIG_REFRESH_WATCH_GLOB = `**/{${[
  ...RSLINT_CONFIG_WATCH_NAMES,
  ...LOCKFILE_NAMES,
].join(',')}}`;

// --- rstack config bridge ---
/**
 * The bridged-folder glob: upstream's names plus `rstack.config.*`, whose
 * edits are the config source of a bridged folder and must produce the same
 * debounced `config-change` refresh. Installed *only* in bridged mode, so a
 * native folder's watcher stays exactly upstream's.
 *
 * One brace group, no nesting — VS Code's glob parser silently fails on nested
 * groups. The only list here that is not local is `RSTACK_CONFIG_PROBE_ORDER`,
 * whose entries are asserted to be plain file names in
 * `tests/stacks/lint/rstackBridge.test.ts`, so appending to it cannot nest a
 * group in this glob.
 */
export const BRIDGED_CONFIG_REFRESH_WATCH_GLOB = `**/{${[
  ...RSLINT_CONFIG_WATCH_NAMES,
  ...RSTACK_CONFIG_PROBE_ORDER,
  ...LOCKFILE_NAMES,
].join(',')}}`;
// --- end rstack config bridge ---

/**
 * The project's `@rslint/core` is outside the support matrix.
 * Distinct from a crash so the status bar can show `version mismatch` with the
 * actual and the required version.
 */
export class RslintVersionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RslintVersionMismatchError';
  }
}

export type ConfigRefreshReason =
  'initial' | 'config-change' | 'dependency-change';

interface ConfigRefreshRequest {
  /**
   * The protocol version is no longer a compile-time constant of
   * a bundled loader — it is read from the project-resolved
   * `@rslint/core/config-loader`, so the value the Go server sees is always the
   * one the JS side actually implements.
   */
  protocolVersion: number;
  reason: ConfigRefreshReason;
  // --- rstack config bridge ---
  /**
   * Absolute native path (not a `file:` URI) of the generated shim in bridged
   * mode. Sent on the *first* refresh (reason `initial`) and identically on
   * every later one — the server rejects a changed or newly appearing value
   * with `InvalidParams`. Absent in native mode, which is what selects the
   * server's automatic discovery.
   */
  configPath?: string;
  // --- end rstack config bridge ---
}

export type ConfigRefreshRequester = (
  reason: ConfigRefreshReason,
  beforeRequest?: (adapter: LspConfigTransactionAdapter) => Promise<void>,
) => Promise<void>;

/**
 * Recover the extension-side transaction host when LanguageClient restarts its
 * native server. The listener using this helper is installed only after the
 * initial Running transition, so a later Running state unambiguously means the
 * replacement process needs a new initial catalog.
 */
export function recoverConfigDiscoveryOnServerState(
  newState: State,
  requestConfigRefresh: ConfigRefreshRequester,
): Promise<void> | undefined {
  if (newState !== State.Running) return undefined;
  return requestConfigRefresh('initial', async (adapter) =>
    adapter.resetForServerRestart(),
  );
}

export function shouldResetDocumentSessionOnServerState(
  oldState: State,
  newState: State,
): boolean {
  return oldState === State.Running && newState !== State.Running;
}

/** Bind each language client to the workspace whose Go process owns discovery. */
export function createLanguageClientOptions(
  workspaceFolder: WorkspaceFolder,
  outputChannel: OutputChannel | undefined,
  middleware?: Middleware,
): LanguageClientOptions {
  const documentSelector = createWorkspaceDocumentSelector(workspaceFolder);
  return {
    workspaceFolder,
    // languageclient v9 types this client-only selector as the LSP shape,
    // whose pattern is string-only. Its converter forwards the pattern to
    // VS Code's DocumentFilter, which supports RelativePattern and preserves
    // an unambiguous workspace base even when the path contains glob syntax.
    documentSelector:
      // rslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      documentSelector as unknown as LanguageClientOptions['documentSelector'],
    outputChannel,
    middleware,
  };
}

export function configRefreshReasonForPath(
  filePath: string,
): Exclude<ConfigRefreshReason, 'initial'> {
  const basename = path.basename(filePath);
  if ((LOCKFILE_NAMES as readonly string[]).includes(basename)) {
    return 'dependency-change';
  }
  return 'config-change';
}

export function isConfigSourceChangeDuringTransaction(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return (
    error.code === 'CONFIG_CHANGED_DURING_LOAD' ||
    (typeof error.message === 'string' &&
      error.message.includes('config changed while'))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function retryConfigRefreshOnSourceChange(
  initial: () => Promise<void>,
  retry: () => Promise<void>,
): Promise<boolean> {
  try {
    await initial();
    return false;
  } catch (error) {
    if (!isConfigSourceChangeDuringTransaction(error)) throw error;
    await retry();
    return true;
  }
}

async function withCancellationSignal<T>(
  token: CancellationToken,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  const subscription = token.onCancellationRequested(() => {
    controller.abort();
  });
  try {
    return await operation(controller.signal);
  } finally {
    subscription.dispose();
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Rslint workspace start was cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export interface LanguageClientCloseTarget {
  readonly state: State;
  readonly diagnostics: Disposable | undefined;
  dispose(): Promise<void>;
}

/**
 * vscode-languageclient calls stop() without observing its promise when an
 * initialize request fails. Its base stop rejects for non-Running states; the
 * process owner handles those states, so normalize only that inactive case and
 * preserve actionable failures from a Running shutdown.
 */
export class ManagedLanguageClient extends LanguageClient {
  public override async stop(timeout?: number): Promise<void> {
    const stateBeforeStop = this.state;
    try {
      await super.stop(timeout);
    } catch (error) {
      if (stateBeforeStop === State.Running) throw error;
    }
  }
}

/**
 * Disposes a LanguageClient without waiting for a possibly hung initialize
 * request. Its outer LanguageServerProcessOwner blocks restarts and terminates
 * the callback-owned child after an inactive-state rejection; failures from a
 * Running client remain independently actionable.
 */
export async function disposeLanguageClient(
  client: LanguageClientCloseTarget,
): Promise<void> {
  const diagnostics = client.diagnostics;
  const reportDisposeFailure = client.state === State.Running;
  const errors: unknown[] = [];
  try {
    await client.dispose();
  } catch (error) {
    if (reportDisposeFailure) errors.push(error);
  }
  try {
    diagnostics?.dispose();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'failed to dispose language client');
  }
}

export async function waitForPromiseSettlement(
  promise: Promise<unknown>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
      }),
    ]);
    if (!settled) {
      throw new Error(`${description} did not settle within ${timeoutMs}ms`);
    }
  } finally {
    clearTimeout(timer);
  }
}

interface ClientStoppedObservation {
  readonly promise: Promise<void>;
  dispose(): void;
}

function observeClientStopped(
  client: LanguageClient,
): ClientStoppedObservation {
  if (client.state === State.Stopped) {
    return { promise: Promise.resolve(), dispose: () => undefined };
  }
  let subscription: Disposable | undefined;
  const promise = new Promise<void>((resolve) => {
    subscription = client.onDidChangeState((event) => {
      if (event.newState === State.Stopped) resolve();
    });
  });
  return {
    promise,
    dispose() {
      subscription?.dispose();
      subscription = undefined;
    },
  };
}

/** Config files detection found for this folder, read at every start. */
export interface RslintFolderConfigPaths {
  /** Native `rslint.config.{js,mjs,ts,mts}` files. */
  readonly rslintConfigPaths: readonly string[];
  // --- rstack config bridge ---
  /**
   * Every `rstack.config.*` in the folder — the whole list, not just the root
   * one: "a native config anywhere wins" and "the Rstack config must be at the
   * root" are one decision, taken in `decideLintConfigMode`.
   */
  readonly rstackConfigPaths: readonly string[];
  // --- end rstack config bridge ---
}

/**
 * The status-aggregation adaptation: this runtime owns no status bar item. It pushes
 * its folder-level state to the stack controller, which aggregates every folder
 * into the one shared status bar entry.
 */
export type RslintStatusSink = (state: StackState) => void;

export interface RslintOptions {
  readonly rootKey: string;
  readonly workspaceFolder: WorkspaceFolder;
  /** The shell-owned `Rstack: Rslint` channel. */
  readonly outputChannel: OutputChannel;
  /**
   * Trace sink for `rstack.rslint.trace.server`. The extension deliberately
   * caps itself at four channels, so this is the same channel as `outputChannel`
   * unless a caller wants them split.
   */
  readonly lspOutputChannel: OutputChannel;
  readonly router: WorkspaceDocumentRouter;
  /** Folder-scoped view of the shell's shared output channel. */
  readonly logger: Logger;
  readonly reportStatus: RslintStatusSink;
  /** Read lazily so a re-start after a detection change sees current paths. */
  readonly getConfigPaths: () => RslintFolderConfigPaths;
}

export class Rslint implements Disposable {
  private client: LanguageClient | undefined;
  private readonly logger: Logger;
  public readonly rootKey: string;
  public readonly workspaceFolder: WorkspaceFolder;
  private readonly router: WorkspaceDocumentRouter;
  private readonly reportStatus: RslintStatusSink;
  private readonly getConfigPaths: () => RslintFolderConfigPaths;
  /** Set by `startImpl` before anything can use a project-resolved module. */
  private resolution: RslintResolution | undefined;
  private configLoader: ConfigLoaderModule | undefined;
  // --- rstack config bridge ---
  /**
   * This lifecycle's bridged state, or `undefined` in native mode. Set once, as
   * a whole, before the client starts: the pin must be identical on every
   * `rslint/configRefresh` of that server, and the two halves are never
   * individually meaningful — a folder is either pinned to a shim generated
   * from a known Rstack config, or it is in native mode.
   */
  private bridge:
    | {
        /** The generated shim the server is pinned to. */
        readonly configPath: string;
        /**
         * The Rstack config the shim was generated from, kept for the *only*
         * thing that may rewrite the shim after the start: a dependency change,
         * which can delete it (it lives under `node_modules`) or dangle the
         * store path baked into it.
         */
        readonly rstackConfigPath: string;
      }
    | undefined;
  // --- end rstack config bridge ---
  /** Non-fatal notes appended to the folder's status detail. */
  private statusNotes: string[] = [];
  private readonly lspOutputChannel: OutputChannel | undefined;
  private readonly outputChannel: OutputChannel | undefined;
  private configWatcher: FileSystemWatcher | undefined;
  private configReloadTimer: ReturnType<typeof setTimeout> | undefined;
  private configReloadChain: Promise<void> = Promise.resolve();
  private serverRestartWatcher: Disposable | undefined;
  private serverProcessOwner: LanguageServerProcessOwner | undefined;
  private stateWatcher: Disposable | undefined;
  private readonly requestHandlers: Disposable[] = [];
  private lifecycleEpoch = 0;
  private pluginDependencyRevision = 0;
  private pluginLintPoolDisposed = false;
  private configTransactionAdapter: LspConfigTransactionAdapter | undefined;
  private startPromise: Promise<void> | undefined;
  private startOperation: Promise<void> | undefined;
  private clientStartPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closing = false;
  /**
   * Hosts the in-process WorkerPool that answers Go's reverse
   * `rslint/pluginLint` requests for rules mounted via a config's
   * object-form `plugins`. It stays uninitialized until a config actually
   * mounts plugins.
   */
  private readonly pluginLintPool: PluginLintPool;

  constructor(options: RslintOptions) {
    this.rootKey = options.rootKey;
    this.workspaceFolder = options.workspaceFolder;
    this.router = options.router;
    this.reportStatus = options.reportStatus;
    this.getConfigPaths = options.getConfigPaths;
    const logger = options.logger;
    this.logger = logger;
    this.lspOutputChannel = options.lspOutputChannel;
    this.outputChannel = options.outputChannel;
    try {
      // The resolve-from-project adaptation: the ESLint-plugin host is loaded from the project,
      // out of the same `@rslint/core` install as the Go binary. The factory is
      // only invoked once a config actually mounts plugins, which is always
      // after `startImpl` published `this.resolution`.
      this.pluginLintPool = new PluginLintPool(logger, async (configs, onLog) =>
        this.createPluginHost(configs, onLog),
      );
    } catch (error) {
      logger.dispose();
      throw error;
    }
  }

  private async createPluginHost(
    configs: ConfigDescriptor[],
    onLog: (rec: { level: string; source: string; text: string }) => void,
  ): Promise<PluginLintHost> {
    const resolution = this.resolution;
    if (!resolution) {
      throw new Error(
        'the ESLint-plugin host was requested before @rslint/core was resolved from the project',
      );
    }
    const module = await loadEslintPluginModule(resolution);
    return module.createPluginLintHost(configs, onLog);
  }

  /** Folder-level status, aggregated by the stack controller (the status-aggregation adaptation). */
  private report(state: StackState): void {
    this.reportStatus(state);
  }

  private runningDetail(): string | undefined {
    return this.statusNotes.length > 0
      ? this.statusNotes.join('; ')
      : undefined;
  }

  private addStatusNote(note: string): void {
    if (!this.statusNotes.includes(note)) {
      this.statusNotes.push(note);
    }
    if (this.isRunning()) {
      this.report({ kind: 'running', detail: this.runningDetail() });
    }
  }

  public async start(signal: AbortSignal): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    if (this.closing || signal.aborted) {
      throw abortError(signal);
    }
    this.startOperation = this.startImpl(signal).catch((error: unknown) => {
      this.reportStartFailure(error);
      throw error;
    });
    // The abort facade releases the per-URI coordinator even when JavaScript
    // module evaluation itself cannot be interrupted. startImpl retains its
    // own rejection handler and epoch checks so a late completion is harmless.
    this.startPromise = raceWithAbort(this.startOperation, signal);
    void this.startOperation.catch(() => undefined);
    await this.startPromise;
  }

  /**
   * Resolution failure surfaces in the status bar; no silent fallback.
   * The two version seams (the support matrix and the config-discovery
   * protocol) are additionally separated from an ordinary crash.
   */
  private reportStartFailure(error: unknown): void {
    if (
      this.closing ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      return;
    }
    if (
      error instanceof RslintVersionMismatchError ||
      error instanceof ConfigDiscoveryProtocolMismatchError ||
      // --- rstack config bridge ---
      // A refused bridged folder is a package problem with a written-out fix,
      // never a crash.
      error instanceof RstackBridgeGateError
      // --- end rstack config bridge ---
    ) {
      this.report({ kind: 'version-mismatch', detail: error.message });
      return;
    }
    const detail =
      error instanceof RslintResolutionError || error instanceof Error
        ? error.message
        : String(error);
    this.report({ kind: 'crashed', detail });
  }

  private async startImpl(signal: AbortSignal): Promise<void> {
    this.configReloadChain = Promise.resolve();
    this.lifecycleEpoch++;
    const epoch = this.lifecycleEpoch;
    const pluginLintPool = this.pluginLintPool;
    this.pluginDependencyRevision = 0;
    this.statusNotes = [];
    this.report({ kind: 'starting' });

    // --- rstack config bridge ---
    // Ownership is decided before anything else, because it changes what a
    // resolution failure *means*: a bridged folder was lit by an
    // `rstack.config.*` alone, where `@rslint/core` is only rstack's transitive
    // dependency and an isolated `node_modules` layout legitimately hides it.
    // The decision itself is taken once per lifecycle and never revisited — the
    // server's explicit-config choice is immutable, so a folder that flips
    // Ownership is restarted by the controller instead of re-signalled here.
    const bridgeConfigPaths = this.getConfigPaths();
    const mode = decideLintConfigMode({
      folderPath: this.workspaceFolder.uri.fsPath,
      rslintConfigPaths: bridgeConfigPaths.rslintConfigPaths,
      rstackConfigPaths: bridgeConfigPaths.rstackConfigPaths,
    });
    // --- end rstack config bridge ---

    // One resolution root for the binary, the config-loader and
    // the ESLint-plugin host — asserted inside `resolveRslint`. A failure here
    // is terminal and user-visible; there is no built-in binary to fall back to.
    // --- rstack config bridge ---
    // Upstream calls `resolveRslint(this.workspaceFolder, this.logger)` here;
    // the wrapper adds nothing but the reclassification of a bridged folder's
    // failure.
    const resolution = await this.resolveToolchain(mode);
    // --- end rstack config bridge ---
    this.assertStartCurrent(epoch, signal);
    this.resolution = resolution;
    this.logger.info(
      `Rslint resolved from the project (${resolution.kind}): ${resolution.coreDir}` +
        ` (version ${resolution.coreVersion ?? 'unknown'})`,
    );

    // Compatibility seam (1): the support matrix. `@rslint/core` older than the
    // launch floor has no `./config-loader` / `./eslint-plugin` export at all,
    // so this check must precede the module load to produce the better message.
    const versionCheck = checkPackageVersion(
      '@rslint/core',
      resolution.coreVersion,
    );
    if (versionCheck.kind === 'mismatch') {
      throw new RslintVersionMismatchError(
        formatVersionMismatch('@rslint/core', versionCheck),
      );
    }

    // Compatibility seam (2): the config-discovery protocol handshake. The value
    // this yields is what every `rslint/configRefresh` request carries and what
    // every server-initiated transaction is validated against, so the Go
    // binary and the JS loader can never silently disagree.
    const configLoader = await loadConfigLoaderModule(resolution);
    this.assertStartCurrent(epoch, signal);
    this.configLoader = configLoader;
    this.logger.debug(
      `Config-discovery protocol version ${configLoader.CONFIG_DISCOVERY_PROTOCOL_VERSION} (project loader: ${resolution.configLoaderPath})`,
    );

    // Compatibility seam (3): the jiti preflight. `@rslint/core`'s config-file-loader
    // falls back to jiti when the host's Node cannot strip types, and the host
    // Node version is fixed by VS Code rather than by the user.
    const jitiNote = describeJitiPreflight({
      folder: this.workspaceFolder,
      coreDir: resolution.coreDir,
      rslintConfigPaths: this.getConfigPaths().rslintConfigPaths,
    });
    if (jitiNote) {
      this.logger.warn(jitiNote);
      this.statusNotes.push(jitiNote);
    }

    // --- rstack config bridge ---
    if (mode.kind === 'bridged') {
      // Published as one value only once the gate let the folder through, so a
      // refused folder holds no half-state.
      this.bridge = {
        configPath: this.prepareBridgedFolder(
          mode,
          configLoader,
          resolution.coreVersion,
        ),
        rstackConfigPath: mode.rstackConfigPath,
      };
    } else {
      this.bridge = undefined;
      // A folder that flipped back to native mode keeps no artifact of the mode
      // it left: the shim is a file named `rslint.config.mjs` naming a config
      // that no longer governs anything.
      if (removeGeneratedShim(this.workspaceFolder.uri.fsPath)) {
        this.logger.info(
          'Removed the generated Rslint config shim left by an earlier bridged start',
        );
      }
    }
    // --- end rstack config bridge ---

    const binPath = resolution.binPath;
    this.logger.info('Rslint binary path:', binPath);

    const serverProcessOwner = new LanguageServerProcessOwner(
      binPath,
      ['--lsp'],
      this.workspaceFolder.uri.fsPath,
    );
    this.serverProcessOwner = serverProcessOwner;
    const serverOptions: ServerOptions = async () => {
      const process = await serverProcessOwner.start();
      return process;
    };

    // Check if LSP tracing is enabled
    const traceServer = workspace
      .getConfiguration('rstack.rslint', this.workspaceFolder.uri)
      .get<string>('trace.server', 'off');
    const traceEnabled = traceServer !== 'off';

    const clientOptions = createLanguageClientOptions(
      this.workspaceFolder,
      this.outputChannel,
      this.router.createMiddleware(this),
    );
    const errorHandlerHolder: { current?: ErrorHandler } = {};
    clientOptions.errorHandler = {
      error: async (error, message, count) => {
        const result = await Promise.resolve(
          errorHandlerHolder.current?.error(error, message, count) ?? {
            action: ErrorAction.Shutdown,
          },
        );
        return result;
      },
      closed: async () => {
        if (this.closing) {
          return { action: CloseAction.DoNotRestart, handled: true };
        }
        const result = await Promise.resolve(
          errorHandlerHolder.current?.closed() ?? {
            action: CloseAction.DoNotRestart,
          },
        );
        return result;
      },
    };

    if (traceEnabled) {
      clientOptions.traceOutputChannel = this.lspOutputChannel;
      this.logger.info(
        'LSP tracing enabled, the trace is written to the "Rstack: Rslint" output channel',
      );
    } else {
      this.logger.debug('LSP tracing disabled by configuration');
    }

    const client = new ManagedLanguageClient(
      'rslint',
      `Rslint Language Server (${this.workspaceFolder.name})`,
      serverOptions,
      clientOptions,
    );
    errorHandlerHolder.current = client.createDefaultErrorHandler();
    this.client = client;
    this.stateWatcher = client.onDidChangeState((event) => {
      this.logger.debug(
        `Language client state ${event.oldState} -> ${event.newState}`,
      );
      if (this.closing || client !== this.client) {
        return;
      }
      if (event.newState === State.Stopped) {
        // The process owner and languageclient's error handler decide whether
        // a restart happens; either way the user must see that this folder is
        // currently not linting.
        this.report({
          kind: 'crashed',
          detail: 'the Rslint language server stopped',
        });
      } else if (event.newState === State.Running) {
        this.report({ kind: 'running', detail: this.runningDetail() });
      }
    });

    try {
      const clientStartPromise = client.start();
      this.clientStartPromise = clientStartPromise;
      await clientStartPromise;
      this.assertStartCurrent(epoch, signal, client);

      const adapter = new LspConfigTransactionAdapter(
        new configLoader.ConfigModuleHost(),
        pluginLintPool,
        (activation) => this.computeActivationFingerprint(activation),
        configLoader.CONFIG_DISCOVERY_PROTOCOL_VERSION,
        (error) => {
          this.report({ kind: 'version-mismatch', detail: error.message });
        },
      );
      this.configTransactionAdapter = adapter;

      this.requestHandlers.push(
        client.onRequest(
          'rslint/loadConfigs',
          async (params: LoadConfigsRequest, token: CancellationToken) =>
            this.observeConfigTransaction(async () =>
              withCancellationSignal(token, async (requestSignal) =>
                adapter.loadConfigs(params, requestSignal),
              ),
            ),
        ),
      );
      this.requestHandlers.push(
        client.onRequest(
          'rslint/activateConfigs',
          async (params: ActivateConfigsRequest, token: CancellationToken) =>
            this.observeConfigTransaction(async () =>
              withCancellationSignal(token, async (requestSignal) =>
                adapter.activateConfigs(params, requestSignal),
              ),
            ),
        ),
      );
      this.requestHandlers.push(
        client.onRequest(
          'rslint/commitConfigs',
          async (params: ConfigTransactionControlRequest) =>
            adapter.commitConfigs(params),
        ),
      );
      this.requestHandlers.push(
        client.onRequest(
          'rslint/abortConfigs',
          async (params: ConfigTransactionControlRequest) =>
            adapter.abortConfigs(params),
        ),
      );

      // Answer Go's reverse `rslint/pluginLint` requests: Go lints
      // natively but dispatches rules mounted via a config's object-form
      // `plugins` back to us, where the JS WorkerPool runs them. The generic
      // string-method overload of `onRequest` handles server-initiated custom
      // requests. The handler's CancellationToken — fired when Go sends
      // $/cancelRequest for a superseded keystroke / closed document — is
      // threaded through to the pool, which bridges it to an AbortSignal and
      // cancels the in-flight worker tasks.
      this.requestHandlers.push(
        client.onRequest(
          'rslint/pluginLint',
          async (params: EslintPluginLintRequest, token: CancellationToken) =>
            pluginLintPool.lint(params, token),
        ),
      );

      // client.start() has already emitted the initial Running transition. Any
      // later Running event belongs to an automatic native-server restart.
      // Reset router-side server-open state before LanguageClient replays open
      // documents, then rebuild the replacement Go process's config catalog.
      this.serverRestartWatcher = client.onDidChangeState((event) => {
        if (
          shouldResetDocumentSessionOnServerState(
            event.oldState,
            event.newState,
          )
        ) {
          this.router.resetServerSession(this).catch((error: unknown) => {
            this.logger.error(
              'Failed to reset documents after server exit',
              error,
            );
          });
        }
        const recovery = recoverConfigDiscoveryOnServerState(
          event.newState,
          async (reason, beforeRequest) => {
            await this.router.resetServerSession(this);
            await this.requestConfigRefresh(reason, beforeRequest);
          },
        );
        recovery?.then(
          () => {
            this.logger.info(
              'Documents and config discovery recovered after server restart',
            );
          },
          (error: unknown) => {
            this.logger.error('Failed to recover after server restart', error);
          },
        );
      });

      if (traceEnabled) {
        const traceLevel =
          traceServer === 'verbose' ? Trace.Verbose : Trace.Messages;
        await client.setTrace(traceLevel);
        this.assertStartCurrent(epoch, signal, client);
        this.logger.info(`LSP trace level set to: ${traceServer}`);
      }

      this.installConfigRefreshWatcher();
      // The watcher is live before initial discovery, so a mutation during a
      // slow module evaluation schedules a second serialized transaction.
      // A plugin worker is prepared between two config fingerprints. If the
      // initial source changes in that window, Go correctly aborts the
      // generation. Retry once from the now-current bytes instead of tearing
      // down the language client before the already-live watcher can recover.
      const retried = await retryConfigRefreshOnSourceChange(
        async () => {
          await this.requestConfigRefresh('initial');
        },
        async () => {
          await this.requestConfigRefresh('config-change');
        },
      );
      this.assertStartCurrent(epoch, signal, client);
      if (retried) {
        this.logger.warn(
          'Config changed during initial activation; discovery recovered on retry',
        );
      }

      this.logger.info('Rslint language client started successfully');
      // Any bridge note was already collected before the client started, so it
      // is part of the very first `running` detail.
      this.report({ kind: 'running', detail: this.runningDetail() });
    } catch (err: unknown) {
      this.logger.error('Failed to start Rslint language client', err);
      throw err;
    }
  }

  // --- rstack config bridge ---
  /**
   * Upstream's project resolution, plus one reclassification: in a bridged
   * folder a missing `@rslint/core` is not a crash.
   *
   * Nothing in such a folder asked for Rslint by name — detection lit the stack
   * off an `rstack.config.*`, and `@rslint/core` reaches the project only as
   * rstack's transitive dependency, which an isolated `node_modules` layout
   * (pnpm) does not expose. Reporting that as `crashed` would put the loudest
   * state in the status bar for a project that is not broken, mask every other
   * folder's real state, and never reach the gate message that explains the
   * fix. Native mode's failure path is untouched.
   */
  private async resolveToolchain(
    mode: LintConfigMode,
  ): Promise<RslintResolution> {
    try {
      return await resolveRslint(this.workspaceFolder, this.logger);
    } catch (error) {
      if (mode.kind === 'bridged' && error instanceof RslintResolutionError) {
        throw new RstackBridgeGateError(
          formatBridgeToolchainGap(mode.rstackConfigPath, error.message),
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * Writes the generated shim from the project's *current* `rstack/config`
   * resolution.
   *
   * The loader is re-resolved on every call by design: its path is realpath'd
   * into a version-pinned store, and both callers are moments where an install
   * may just have moved it.
   */
  private materializeShim(rstackConfigPath: string): GeneratedShim {
    const folderPath = this.workspaceFolder.uri.fsPath;
    return writeGeneratedShim({
      folderPath,
      configLoaderPath: resolveRstackConfigLoader(folderPath),
      rstackConfigPath,
    });
  }

  /**
   * Re-materializes the generated shim under its existing path.
   *
   * Called on a dependency change and nowhere else. A reinstall can delete the
   * shim outright (it lives under `node_modules`) or leave the loader path
   * baked into it dangling, since that path is realpath'd into a
   * version-pinned store — and the `configPath` the server was pinned to is
   * immutable for its process lifetime, so the file has to come back at the
   * same path rather than the pin moving to a new one.
   */
  private refreshGeneratedShim(): void {
    const bridge = this.bridge;
    if (!bridge) {
      return;
    }
    try {
      const shim = this.materializeShim(bridge.rstackConfigPath);
      if (shim.written) {
        this.logger.info(
          `Re-materialized the generated Rslint config shim after a dependency change: ${shim.path}`,
        );
      }
    } catch (error) {
      // The pin cannot move, so this is as far as recovery goes: say what
      // happened and what clears it.
      this.logger.error(
        'Failed to re-materialize the generated Rslint config shim',
        error,
      );
      this.addStatusNote(
        'the generated Rslint config shim could not be rewritten after a dependency change; run Rstack: Restart Rslint',
      );
    }
  }

  /**
   * Prepares a bridged folder and returns the `configPath` its server is
   * pinned to.
   *
   * Order matters. The capability gate runs *first*: without protocol >= 2
   * there is no channel to pin anything to, so writing a shim would leave a
   * file behind for a mode that cannot start. The failure is a
   * `version mismatch` status, not a crash — the fix is a package upgrade.
   */
  private prepareBridgedFolder(
    mode: Extract<LintConfigMode, { kind: 'bridged' }>,
    configLoader: ConfigLoaderModule,
    coreVersion: string | undefined,
  ): string {
    const protocolVersion = configLoader.CONFIG_DISCOVERY_PROTOCOL_VERSION;
    if (!supportsExplicitConfigPath(protocolVersion)) {
      throw new RstackBridgeGateError(
        formatBridgeProtocolGate(protocolVersion, coreVersion),
      );
    }
    const shim = this.materializeShim(mode.rstackConfigPath);
    this.logger.info(
      `${shim.written ? 'Wrote' : 'Reused'} the generated Rslint config shim for ${mode.rstackConfigPath}: ${shim.path}`,
    );

    // Compatibility seam (4): the rstack-loader preflight. rstack's loader
    // hardcodes native type stripping with no jiti fallback, so a TypeScript
    // Rstack config can be unloadable on this host even though the CLI loads
    // it fine.
    const loaderNote = describeRstackConfigLoaderPreflight({
      rstackConfigPath: mode.rstackConfigPath,
      nativeTypeStripping: nativeTypeStrippingAvailable(),
    });
    if (loaderNote) {
      this.logger.warn(loaderNote);
      this.statusNotes.push(loaderNote);
    }
    this.statusNotes.push(
      `linting from ${path.basename(mode.rstackConfigPath)}`,
    );
    return shim.path;
  }
  // --- end rstack config bridge ---

  /**
   * Surfaces the two failure classes that must stay actionable
   * instead of generic: a config-discovery protocol disagreement and the
   * config-file-loader's "Install jiti as a dependency" error.
   */
  private async observeConfigTransaction<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ConfigTransactionProtocolMismatchError) {
        // Already reported through the adapter's `onProtocolMismatch`.
        throw error;
      }
      if (isJitiMissingError(error)) {
        this.addStatusNote(
          'a TypeScript Rslint config could not be loaded: ' +
            JITI_INSTALL_HINT,
        );
      }
      throw error;
    }
  }

  private assertStartCurrent(
    epoch: number,
    signal: AbortSignal,
    client?: LanguageClient,
  ): void {
    throwIfAborted(signal);
    if (
      this.closing ||
      epoch !== this.lifecycleEpoch ||
      (client !== undefined && client !== this.client)
    ) {
      throw abortError(signal);
    }
  }

  private installConfigRefreshWatcher(): void {
    this.configWatcher = workspace.createFileSystemWatcher(
      // Go owns the config-scoped .gitignore watcher and refresh transaction.
      // Keeping it out of this direct watcher prevents one mutation from
      // starting both a didChangeWatchedFiles and a configRefresh transaction.
      new RelativePattern(
        this.workspaceFolder,
        // --- rstack config bridge ---
        // A bridged folder also watches its config source; native mode keeps
        // upstream's glob exactly.
        this.bridge === undefined
          ? CONFIG_REFRESH_WATCH_GLOB
          : BRIDGED_CONFIG_REFRESH_WATCH_GLOB,
        // --- end rstack config bridge ---
      ),
    );
    const refreshConfig = (uri: Uri) => {
      const reason = configRefreshReasonForPath(uri.fsPath);
      if (reason === 'dependency-change') {
        // The actual package contents can change while config source bytes stay
        // identical. Feed a monotonic dependency revision into the staged host
        // fingerprint so any lockfile mutation forces a worker rebuild.
        this.pluginDependencyRevision++;
      }
      this.logger.debug(`${reason}: ${uri.fsPath}`);
      clearTimeout(this.configReloadTimer);
      this.configReloadTimer = setTimeout(() => {
        this.configReloadTimer = undefined;
        this.requestConfigRefresh(reason).catch((err: unknown) => {
          this.logger.error('Failed to refresh config discovery', err);
        });
      }, 300);
    };
    this.configWatcher.onDidChange(refreshConfig);
    this.configWatcher.onDidCreate(refreshConfig);
    this.configWatcher.onDidDelete(refreshConfig);
  }

  private async requestConfigRefresh(
    reason: ConfigRefreshReason,
    beforeRequest?: (adapter: LspConfigTransactionAdapter) => Promise<void>,
  ): Promise<void> {
    const epoch = this.lifecycleEpoch;
    const client = this.client;
    const pluginLintPool = this.pluginLintPool;
    const adapter = this.configTransactionAdapter;
    const configLoader = this.configLoader;
    if (!client || !adapter || !configLoader || this.pluginLintPoolDisposed) {
      return;
    }
    const refresh = this.configReloadChain.then(async () => {
      if (
        !this.isLifecycleCurrent(epoch, client, pluginLintPool) ||
        adapter !== this.configTransactionAdapter
      ) {
        return;
      }
      await beforeRequest?.(adapter);
      if (
        !this.isLifecycleCurrent(epoch, client, pluginLintPool) ||
        adapter !== this.configTransactionAdapter
      ) {
        return;
      }
      // --- rstack config bridge ---
      // The one thing that can invalidate a bridged folder's pin without
      // changing it: a reinstall under the shim, whose file the server is about
      // to be told to reload.
      if (reason === 'dependency-change') {
        this.refreshGeneratedShim();
      }
      // --- end rstack config bridge ---
      const request: ConfigRefreshRequest = {
        protocolVersion: configLoader.CONFIG_DISCOVERY_PROTOCOL_VERSION,
        reason,
        // --- rstack config bridge ---
        // Spread, not `configPath: this.bridge?.configPath`: an explicit
        // `undefined` still serializes as a present key on some transports,
        // and "present" is what selects explicit mode. In native mode the
        // request must stay byte-identical to upstream's.
        ...(this.bridge === undefined
          ? {}
          : { configPath: this.bridge.configPath }),
        // --- end rstack config bridge ---
      };
      await client.sendRequest('rslint/configRefresh', request);
    });
    this.configReloadChain = refresh.catch(() => undefined);
    await refresh;
  }

  private isLifecycleCurrent(
    epoch: number,
    client: LanguageClient,
    pluginLintPool: PluginLintPool,
  ): boolean {
    return (
      epoch === this.lifecycleEpoch &&
      client === this.client &&
      pluginLintPool === this.pluginLintPool &&
      !this.pluginLintPoolDisposed &&
      !this.closing
    );
  }

  /**
   * Fingerprint the inputs that decide whether the plugin host must rebuild:
   * Go's selected config snapshots plus each workspace-root lockfile's
   * existence, mtime, and size. A dependency install can replace plugin code
   * without changing config, so the lockfile also feeds the key.
   */
  private computeMetadataFingerprint(filePath: string): string {
    try {
      const stat = fs.statSync(filePath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return 'absent';
    }
  }

  private computeActivationFingerprint(
    activation: ConfigModuleActivationPlan,
  ): string {
    const sourceFingerprint = this.computeFingerprint(
      activation.pluginConfigs.map((config) => config.configPath),
      activation.configs,
    );
    return `${sourceFingerprint}|dependency-revision:${this.pluginDependencyRevision}`;
  }

  private computeFingerprint(
    configPaths: string[],
    configs: ReadonlyArray<{
      configPath: string;
      sourceFingerprint: string;
    }>,
  ): string {
    const parts: string[] = [];
    const sourceFingerprintByPath = new Map(
      configs.map((config) => [
        path.normalize(config.configPath),
        config.sourceFingerprint,
      ]),
    );
    for (const p of [...configPaths].sort()) {
      const sourceFingerprint = sourceFingerprintByPath.get(path.normalize(p));
      if (sourceFingerprint === undefined) {
        throw new Error(`missing source fingerprint for plugin config ${p}`);
      }
      parts.push(`${p}:${sourceFingerprint}`);
    }
    for (const name of LOCKFILE_NAMES) {
      const lockPath = path.join(this.workspaceFolder.uri.fsPath, name);
      parts.push(`lock:${name}:${this.computeMetadataFingerprint(lockPath)}`);
    }
    return parts.join('|');
  }

  public async close(): Promise<void> {
    await (this.closePromise ??= this.closeImpl());
  }

  private async closeImpl(): Promise<void> {
    const errors: unknown[] = [];
    const disposeSafely = (resource: Disposable | undefined): void => {
      if (!resource) return;
      try {
        resource.dispose();
      } catch (error) {
        errors.push(error);
      }
    };

    this.closing = true;
    this.lifecycleEpoch++;
    clearTimeout(this.configReloadTimer);
    this.configReloadTimer = undefined;
    disposeSafely(this.serverRestartWatcher);
    this.serverRestartWatcher = undefined;
    disposeSafely(this.configWatcher);
    this.configWatcher = undefined;
    // --- rstack config bridge ---
    // The pin belongs to the server process that is going away; the next start
    // decides again from scratch.
    this.bridge = undefined;
    // --- end rstack config bridge ---
    disposeSafely(this.configTransactionAdapter);
    this.configTransactionAdapter = undefined;
    for (const handler of this.requestHandlers.splice(0)) {
      disposeSafely(handler);
    }
    disposeSafely(this.stateWatcher);
    this.stateWatcher = undefined;
    // Do not await startOperation/configReloadChain: user module evaluation can
    // contain a non-settling top-level await. Epoch/closing checks fence every
    // late continuation from publishing resources or state.
    this.configReloadChain = Promise.resolve();
    this.pluginLintPoolDisposed = true;

    const client = this.client;
    this.client = undefined;
    const clientStartPromise = this.clientStartPromise;
    this.clientStartPromise = undefined;
    const clientStopped =
      client?.state === State.Starting
        ? observeClientStopped(client)
        : undefined;
    const serverProcessOwner = this.serverProcessOwner;
    this.serverProcessOwner = undefined;
    // Block vscode-languageclient's automatic restart callback before its
    // graceful client shutdown begins. The owner force-terminates and awaits
    // any surviving child after the bounded protocol shutdown finishes.
    serverProcessOwner?.beginClose();
    const asynchronousCleanups: Promise<void>[] = [
      (async () => {
        await this.pluginLintPool.dispose();
      })(),
    ];
    if (client) {
      asynchronousCleanups.push(
        (async () => {
          const clientErrors: unknown[] = [];
          try {
            await disposeLanguageClient(client);
          } catch (error) {
            clientErrors.push(error);
          }
          try {
            await serverProcessOwner?.close();
          } catch (error) {
            clientErrors.push(error);
          }
          if (clientStartPromise) {
            try {
              await waitForPromiseSettlement(
                clientStartPromise,
                2_000,
                'language client start',
              );
            } catch (error) {
              clientErrors.push(error);
            }
          }
          if (clientStopped) {
            try {
              await waitForPromiseSettlement(
                clientStopped.promise,
                2_000,
                'language client terminal state',
              );
            } catch (error) {
              clientErrors.push(error);
            } finally {
              clientStopped.dispose();
            }
          }
          if (clientErrors.length > 0) {
            throw new AggregateError(
              clientErrors,
              'failed to close language client resources',
            );
          }
        })(),
      );
    } else if (serverProcessOwner) {
      asynchronousCleanups.push(
        (async () => {
          await serverProcessOwner.close();
        })(),
      );
    }
    const results = await Promise.allSettled(asynchronousCleanups);
    this.pluginDependencyRevision = 0;

    for (const result of results) {
      if (result.status === 'rejected') {
        const reason: unknown = result.reason;
        errors.push(reason);
      }
    }
    try {
      for (const error of errors) {
        this.logger.error('Failed to close Rslint workspace resource', error);
      }
      if (errors.length === 0) {
        this.logger.info('Rslint language client closed');
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      this.logger.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'failed to close Rslint workspace');
    }
  }

  public isRunning(): boolean {
    return this.client?.state === State.Running;
  }

  public async sendDocumentOpen(document: TextDocument): Promise<void> {
    const provider = this.client
      ?.getFeature(DidOpenTextDocumentNotification.method)
      .getProvider(document);
    if (!provider) {
      throw new Error(`didOpen provider is unavailable for ${document.uri}`);
    }
    await provider.send(document);
  }

  public async sendDocumentClose(document: TextDocument): Promise<void> {
    const provider = this.client
      ?.getFeature(DidCloseTextDocumentNotification.method)
      .getProvider(document);
    if (!provider) {
      throw new Error(`didClose provider is unavailable for ${document.uri}`);
    }
    await provider.send(document);
  }

  public clearDocumentDiagnostics(uri: Uri): void {
    this.client?.diagnostics?.delete(uri);
  }

  public dispose(): void {
    void this.close().catch(() => undefined);
  }
}
