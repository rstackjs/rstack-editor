import vscode from 'vscode';
import type {
  DetectionSnapshot,
  StackContext,
  StackController,
  StackDetection,
  StackState,
} from '../../types';
import { Logger } from './logger';
import { Rslint, type RslintFolderConfigPaths } from './Rslint';
import {
  decideLintConfigMode,
  lintConfigModeSignature,
  removeGeneratedShim,
  RstackBridgeGateError,
} from './rstackBridge';
import { WorkspaceDocumentRouter } from './WorkspaceDocumentRouter';
import {
  WorkspaceRslintCoordinator,
  workspaceRootKey,
} from './WorkspaceRslintCoordinator';

/**
 * Replaces upstream's `main.ts` + `Extension.ts` + `statusBar.ts` +
 * `commands.ts` (the shell-activation and status-aggregation adaptations).
 *
 * Upstream activates the extension itself and `await`s
 * `coordinator.initialize()`, which resolves only once a language server root
 * is ready — the readiness contract its E2E harness depends on. Here the shell
 * owns activation: `register()` must return as soon as the runtimes are
 * *scheduled*, never block on a Go process start, and every state transition
 * flows into the shared status bar instead of an own status bar item.
 */

const STATE_RANK: Readonly<Record<StackState['kind'], number>> = {
  crashed: 5,
  'version-mismatch': 4,
  starting: 3,
  running: 2,
  disabled: 1,
  'not-detected': 0,
};

interface FolderStatus {
  readonly name: string;
  readonly state: StackState;
  /**
   * The config mode the folder's runtime was started in
   * (`stacks/lint/rstackBridge.ts`). A language server's explicit-config choice
   * is fixed for its process lifetime, so a folder whose Ownership flipped —
   * an `rslint.config.*` appearing in or vanishing from a bridged folder, a
   * root `rstack.config.*` being renamed — needs a *restart*, which a plain
   * reconcile deliberately never does (it leaves live runtimes alone).
   */
  readonly configMode: string;
}

const detailOf = (state: StackState): string | undefined => {
  switch (state.kind) {
    case 'crashed':
    case 'version-mismatch':
      return state.detail;
    case 'starting':
    case 'running':
      return state.detail;
    case 'disabled':
      return state.reason;
    case 'not-detected':
      return undefined;
  }
};

/**
 * Folds every workspace folder's runtime into the one state the status bar
 * shows for the Rslint stack. The worst state wins, and the detail names the
 * folders it came from — with multiple roots, "crashed" without a folder name
 * is not actionable.
 */
export const aggregateFolderStates = (
  // Only the two fields it actually folds: the mode signature riding along on
  // `FolderStatus` is restart bookkeeping and no input to the status bar.
  statuses: readonly Pick<FolderStatus, 'name' | 'state'>[],
): StackState => {
  if (statuses.length === 0) {
    return { kind: 'starting' };
  }
  let worst = statuses[0]!;
  for (const candidate of statuses) {
    if (STATE_RANK[candidate.state.kind] > STATE_RANK[worst.state.kind]) {
      worst = candidate;
    }
  }
  const multiRoot = statuses.length > 1;
  const details = statuses
    .filter((entry) => entry.state.kind === worst.state.kind)
    .map((entry) => {
      const detail = detailOf(entry.state);
      if (!detail) {
        return multiRoot ? entry.name : undefined;
      }
      return multiRoot ? `${entry.name}: ${detail}` : detail;
    })
    .filter((entry): entry is string => entry !== undefined);
  const detail = details.length > 0 ? details.join(' | ') : undefined;

  switch (worst.state.kind) {
    case 'crashed':
      return {
        kind: 'crashed',
        detail: detail ?? 'the language server failed',
      };
    case 'version-mismatch':
      return {
        kind: 'version-mismatch',
        detail: detail ?? 'unsupported @rslint/core version',
      };
    case 'starting':
      return { kind: 'starting', detail };
    case 'running':
      return { kind: 'running', detail };
    case 'disabled':
      return { kind: 'disabled', reason: detail };
    case 'not-detected':
      return { kind: 'not-detected' };
  }
};

const configPathsOf = (
  detection: StackDetection | undefined,
): RslintFolderConfigPaths => ({
  rslintConfigPaths: (detection?.configFiles ?? []).map((uri) => uri.fsPath),
  rstackConfigPaths: (detection?.rstackConfigFiles ?? []).map(
    (uri) => uri.fsPath,
  ),
});

const configModeSignatureOf = (
  folder: vscode.WorkspaceFolder,
  paths: RslintFolderConfigPaths,
): string =>
  lintConfigModeSignature(
    decideLintConfigMode({
      folderPath: folder.uri.fsPath,
      rslintConfigPaths: paths.rslintConfigPaths,
      rstackConfigPaths: paths.rstackConfigPaths,
    }),
  );

interface DetectedLintFolder {
  readonly folder: vscode.WorkspaceFolder;
  /** `lintConfigModeSignature` of the mode this folder starts in. */
  readonly configMode: string;
}

class RslintController implements StackController {
  readonly id = 'rslint' as const;
  // A `binPath`/`customBinPath` change must re-resolve the binary, which only
  // happens on a fresh start (upstream documents `customBinPath` as requiring a
  // reload; a restart is strictly better). A shallower local restart would
  // replace the coordinator but keep this controller's already-resolved binary
  // and version check.
  readonly restartOnSettings = ['binPath', 'customBinPath', 'trace.server'];

  #context: StackContext | undefined;
  #logger: Logger | undefined;
  #coordinator: WorkspaceRslintCoordinator | undefined;
  #snapshot: DetectionSnapshot | undefined;
  readonly #subscriptions: vscode.Disposable[] = [];
  readonly #folderStates = new Map<string, FolderStatus>();
  #disposed = false;

  async register(context: StackContext): Promise<Record<string, unknown>> {
    this.#context = context;
    this.#snapshot = context.detection;
    this.#logger = new Logger(context.output);

    this.#subscriptions.push(
      context.onDidChangeDetection((snapshot) => {
        this.#snapshot = snapshot;
        this.reconcileFolders({ added: [], removed: [] });
        // A detection pass fires on config topology and lockfile changes —
        // exactly the moments a previously failed root (missing binary,
        // uninstalled dependencies) may have become startable.
        this.#coordinator?.retryFailedRoots();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        this.reconcileFolders(event);
      }),
    );

    this.startCoordinator();
    return this.buildExports();
  }

  /**
   * Published through the extension's public exports channel
   * (`RstackExtensionExports.whenStackActive('rslint')`). The E2E harness uses
   * it as the "the shell registered the lint stack" signal — the upstream
   * suites relied on `extension.activate()` resolving only once a server root
   * was ready, a contract the shell no longer provides (the shell-activation
   * adaptation). The folder-state snapshot is exposed for assertions and
   * debugging; it is not a stable API.
   */
  private buildExports(): Record<string, unknown> {
    return {
      stackId: this.id,
      getFolderStates: (): ReadonlyMap<string, StackState> =>
        new Map(
          [...this.#folderStates].map(([key, value]) => [key, value.state]),
        ),
    };
  }

  /**
   * The workspace folders detection lit up for Rslint, each with the config
   * mode it would start in.
   *
   * Both come out of the same detection entry in one pass: the entry already
   * carries the folder *and* its config file lists, so the mode signature costs
   * nothing beyond the decision itself.
   */
  private detectedFolders(): DetectedLintFolder[] {
    return (this.#snapshot?.foldersFor('rslint') ?? []).map((entry) => ({
      folder: entry.folder,
      configMode: configModeSignatureOf(
        entry.folder,
        configPathsOf(entry.stacks.rslint),
      ),
    }));
  }

  private configPathsFor(
    folder: vscode.WorkspaceFolder,
  ): RslintFolderConfigPaths {
    return configPathsOf(this.#snapshot?.forFolder(folder)?.stacks.rslint);
  }

  private startCoordinator(): void {
    const context = this.#context;
    const logger = this.#logger;
    if (!context || !logger || this.#disposed) {
      return;
    }
    const router = new WorkspaceDocumentRouter();
    const coordinator = new WorkspaceRslintCoordinator(
      router,
      (workspaceFolder, rootKey) =>
        new Rslint({
          rootKey,
          workspaceFolder,
          outputChannel: context.output,
          // The extension is capped at four output channels, so the
          // LSP trace shares the stack's channel instead of opening a fifth.
          lspOutputChannel: context.output,
          router,
          logger: logger.forScope(workspaceFolder.name),
          reportStatus: (state) => {
            this.setFolderState(rootKey, workspaceFolder.name, state);
          },
          getConfigPaths: () => this.configPathsFor(workspaceFolder),
        }),
      logger,
      // A bridge-eligible folder whose `@rslint/core` is missing or too old to
      // be pinned to a config deliberately does not start; the user sees the
      // reason as a `version mismatch` status, so logging it as a failure would
      // only add noise.
      (error) => error instanceof RstackBridgeGateError,
    );
    this.#coordinator = coordinator;

    const detected = this.detectedFolders();
    for (const { folder, configMode } of detected) {
      this.setFolderState(
        workspaceRootKey(folder),
        folder.name,
        { kind: 'starting' },
        configMode,
      );
    }

    // Adaptation #1: activation must not wait for a language server. Upstream
    // awaits this promise (and rejects activation when every root fails); here
    // failures are reported per folder through the status reporter.
    const folders = detected.map((entry) => entry.folder);
    void coordinator.initialize(folders).catch((error: unknown) => {
      if (coordinator !== this.#coordinator) {
        return;
      }
      logger.error('No Rslint workspace root started', error);
    });
  }

  /**
   * Brings the tracked folders back in line with detection — and carries the
   * config-mode flip with it.
   *
   * The flip is not a second pass: this one already walks every detected folder
   * with its mode signature in hand, prunes the folders that vanished, and ends
   * in exactly one `handleWorkspaceFoldersChanged`. A flipped folder therefore
   * just joins that event as both removed and added, which is the coordinator's
   * existing URI-preserving replacement path — the one path that bumps a root's
   * generation, closes the live runtime and starts a fresh one, which is
   * exactly what an immutable explicit-config choice needs.
   */
  private reconcileFolders(event: vscode.WorkspaceFoldersChangeEvent): void {
    const coordinator = this.#coordinator;
    if (!coordinator || this.#disposed) {
      return;
    }
    const detected = this.detectedFolders();
    const keys = new Set<string>();
    const flipped: vscode.WorkspaceFolder[] = [];
    for (const { folder, configMode } of detected) {
      const key = workspaceRootKey(folder);
      keys.add(key);
      const previous = this.#folderStates.get(key);
      if (previous === undefined) {
        // A root with no runtime yet cannot have flipped: record the mode it
        // is about to start in, so only later changes count as a flip.
        this.setFolderState(key, folder.name, { kind: 'starting' }, configMode);
        continue;
      }
      if (previous.configMode === configMode) {
        continue;
      }
      this.#logger?.info(
        `Lint config mode changed for ${folder.name} (${previous.configMode} -> ${configMode}); restarting its language server`,
      );
      this.#folderStates.set(key, { ...previous, configMode });
      flipped.push(folder);
    }
    for (const [key, leaving] of [...this.#folderStates]) {
      if (keys.has(key)) {
        continue;
      }
      // A bridged folder leaving detection (its root `rstack.config.*` deleted
      // or renamed, no native config appearing) never passes through a native
      // start — the only other place the generated shim is deleted — so the
      // extension-owned artifact is removed with the folder. Unconditional on
      // purpose: the delete is idempotent, and testing the mode here would
      // mean parsing the signature this layer otherwise treats as opaque.
      // Deliberately not done on dispose: an undisturbed bridged folder keeps
      // its shim across window reloads and the next start re-materializes it
      // in place. The key is `workspaceRootKey` — the folder URI verbatim.
      if (removeGeneratedShim(vscode.Uri.parse(key).fsPath)) {
        this.#logger?.info(
          `Removed the generated Rslint config shim for ${leaving.name}: the folder is no longer detected`,
        );
      }
      this.#folderStates.delete(key);
    }
    this.publishStatus();
    const folders = detected.map((entry) => entry.folder);
    coordinator.handleWorkspaceFoldersChanged(
      flipped.length === 0
        ? event
        : {
            added: [...event.added, ...flipped],
            removed: [...event.removed, ...flipped],
          },
      folders,
    );
  }

  private setFolderState(
    rootKey: string,
    name: string,
    state: StackState,
    // Passed only where the mode is decided (a folder being recorded for the
    // first time). A status update from a live runtime preserves it: the
    // reconcile that recorded the folder owns the value, and it always ran
    // before any runtime for that folder existed.
    configMode?: string,
  ): void {
    if (this.#disposed) {
      return;
    }
    this.#folderStates.set(rootKey, {
      name,
      state,
      configMode:
        configMode ?? this.#folderStates.get(rootKey)?.configMode ?? '',
    });
    this.publishStatus();
  }

  private publishStatus(): void {
    const context = this.#context;
    if (!context || this.#disposed) {
      return;
    }
    context.status.report(
      aggregateFolderStates([...this.#folderStates.values()]),
    );
  }

  private async closeCoordinator(): Promise<void> {
    const coordinator = this.#coordinator;
    this.#coordinator = undefined;
    if (!coordinator) {
      return;
    }
    try {
      await coordinator.close();
    } catch (error) {
      this.#logger?.error('Failed to close the Rslint coordinator', error);
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const subscription of this.#subscriptions.splice(0)) {
      subscription.dispose();
    }
    await this.closeCoordinator();
    this.#folderStates.clear();
    this.#logger = undefined;
    this.#context = undefined;
    this.#snapshot = undefined;
  }
}

export const createRslintController = (): StackController =>
  new RslintController();
