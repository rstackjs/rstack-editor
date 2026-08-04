import vscode from 'vscode';
import type {
  DetectionSnapshot,
  StackContext,
  StackController,
  StackState,
} from '../../types';
import { Logger } from './logger';
import { Rslint, type RslintFolderConfigPaths } from './Rslint';
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
  statuses: readonly FolderStatus[],
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

class RslintController implements StackController {
  readonly id = 'rslint' as const;

  #context: StackContext | undefined;
  #logger: Logger | undefined;
  #coordinator: WorkspaceRslintCoordinator | undefined;
  #snapshot: DetectionSnapshot | undefined;
  readonly #subscriptions: vscode.Disposable[] = [];
  readonly #folderStates = new Map<string, FolderStatus>();
  #pending: Promise<void> = Promise.resolve();
  #disposed = false;

  async register(context: StackContext): Promise<Record<string, unknown>> {
    this.#context = context;
    this.#snapshot = context.detection;
    this.#logger = new Logger(context.output);

    this.#subscriptions.push(
      vscode.commands.registerCommand('rstack.rslint.restart', () => {
        void this.restart();
      }),
      context.onDidChangeDetection((snapshot) => {
        this.#snapshot = snapshot;
        this.reconcileFolders({ added: [], removed: [] });
      }),
      vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        this.reconcileFolders(event);
      }),
      // A `binPath`/`customBinPath` change must re-resolve the binary, which
      // only happens on a fresh start (upstream documents `customBinPath` as
      // requiring a reload; a restart is strictly better).
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('rstack.rslint.binPath') ||
          event.affectsConfiguration('rstack.rslint.customBinPath') ||
          event.affectsConfiguration('rstack.rslint.trace.server')
        ) {
          void this.restart();
        }
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

  /** The workspace folders detection lit up for Rslint. */
  private detectedFolders(): vscode.WorkspaceFolder[] {
    return (this.#snapshot?.foldersFor('rslint') ?? []).map(
      (entry) => entry.folder,
    );
  }

  private configPathsFor(
    folder: vscode.WorkspaceFolder,
  ): RslintFolderConfigPaths {
    const detection = this.#snapshot?.forFolder(folder)?.stacks.rslint;
    return {
      rslintConfigPaths: (detection?.configFiles ?? []).map(
        (uri) => uri.fsPath,
      ),
    };
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
    );
    this.#coordinator = coordinator;

    const folders = this.detectedFolders();
    for (const folder of folders) {
      this.setFolderState(workspaceRootKey(folder), folder.name, {
        kind: 'starting',
      });
    }

    // Adaptation #1: activation must not wait for a language server. Upstream
    // awaits this promise (and rejects activation when every root fails); here
    // failures are reported per folder through the status reporter.
    void coordinator.initialize(folders).catch((error: unknown) => {
      if (coordinator !== this.#coordinator) {
        return;
      }
      logger.error('No Rslint workspace root started', error);
    });
  }

  private reconcileFolders(event: vscode.WorkspaceFoldersChangeEvent): void {
    const coordinator = this.#coordinator;
    if (!coordinator || this.#disposed) {
      return;
    }
    const folders = this.detectedFolders();
    const keys = new Set(folders.map(workspaceRootKey));
    for (const key of [...this.#folderStates.keys()]) {
      if (!keys.has(key)) {
        this.#folderStates.delete(key);
      }
    }
    for (const folder of folders) {
      const key = workspaceRootKey(folder);
      if (!this.#folderStates.has(key)) {
        this.setFolderState(key, folder.name, { kind: 'starting' });
      }
    }
    this.publishStatus();
    coordinator.handleWorkspaceFoldersChanged(event, folders);
  }

  private setFolderState(
    rootKey: string,
    name: string,
    state: StackState,
  ): void {
    if (this.#disposed) {
      return;
    }
    this.#folderStates.set(rootKey, { name, state });
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

  /**
   * Serializes restart/dispose. Two restarts racing (a settings change plus the
   * palette command) would otherwise interleave close and start and leak a
   * coordinator that nothing holds a reference to any more.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.#pending = this.#pending.then(task, task);
    return this.#pending;
  }

  /**
   * `rstack.rslint.restart`. The coordinator is single-use once closed, so a
   * restart replaces it (and the document router) wholesale — the same shape
   * upstream's commented-out `rslint.restart` would have needed.
   */
  private async restart(): Promise<void> {
    await this.enqueue(async () => {
      if (this.#disposed || !this.#context) {
        return;
      }
      this.#logger?.info('Restarting the Rslint language server');
      await this.closeCoordinator();
      this.#folderStates.clear();
      this.startCoordinator();
    });
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
    // Behind the same queue as `restart`, so an in-flight restart finishes
    // (or no-ops on `#disposed`) before the language servers are torn down.
    await this.enqueue(async () => {
      await this.closeCoordinator();
      this.#folderStates.clear();
      this.#logger = undefined;
      this.#context = undefined;
      this.#snapshot = undefined;
    });
  }
}

export const createRslintController = (): StackController =>
  new RslintController();
