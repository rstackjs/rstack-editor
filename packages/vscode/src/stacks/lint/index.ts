import vscode from 'vscode';
import type {
  DetectionSnapshot,
  StackContext,
  StackController,
  StackState,
} from '../../types';
import { NODE_EXECUTABLE_SETTING } from '../../shared/nodeResolution';
import { CoreResolver, type ResolvedCoreRuntime } from './CoreResolver';
import { Logger } from './logger';
import { Rslint } from './Rslint';
import type { RslintMode } from './resolution';
import { RuntimeManager } from './RuntimeManager';
import {
  aggregateFolderStates,
  attributeToCore,
  foldRslintFolderState,
  statusForRslintStartFailure,
} from './status';
import { WorkspaceDocumentRouter } from './WorkspaceDocumentRouter';

/**
 * Replaces upstream's `main.ts` + `Extension.ts` + `statusBar.ts` +
 * `commands.ts` (the shell-activation and status-aggregation adaptations).
 *
 * Upstream activates the extension itself; here the shell owns activation, so
 * `register()` must return as soon as the folders are registered and the open
 * documents are *scheduled* for reconciliation — never block on a Go process
 * start — and every state transition flows into the shared status bar instead
 * of an own status bar item.
 *
 * Since rslint #1617 the unit of lifecycle is a **Lint runtime** per Rslint
 * core per folder, refcounted by open document: a folder with no open document
 * holds no runtime and reports idle. What this controller owns is exactly what
 * upstream's `Extension.ts` owns — the document and topology triggers — plus
 * the per-folder status fold the shell requires.
 */

/**
 * The one core-topology signal the shell's detection watcher does not carry:
 * a core swapped in place. Lockfiles — upstream's other half of this glob —
 * are already detection's business, and a detection pass notifies this stack
 * even when the folder set is unchanged. `files.watcherExclude` hides
 * `node_modules` by default, so in practice the lockfile path is the one that
 * fires; this watcher costs nothing and covers the rest.
 */
const CORE_TOPOLOGY_GLOB = '**/node_modules/@rslint/core/package.json';

/** Everything one detected folder contributes to its status fold. */
interface FolderStates {
  /** One entry per live Lint runtime, keyed by its runtime key. */
  readonly runtimes: Map<string, StackState>;
  /** One entry per document whose core resolution currently fails. */
  readonly failures: Map<string, StackState>;
}

const folderKeyOf = (folder: vscode.WorkspaceFolder): string =>
  folder.uri.toString();

class RslintController implements StackController {
  readonly id = 'rslint' as const;
  /**
   * Upstream reconciles in place when `corePath` changes; here it stays a
   * restart trigger. The shell answers a relevant settings change with one
   * full restart pass (a stack must never rebuild itself), which also clears
   * the shared User Node preflight memo — an in-place reconcile would keep it.
   */
  readonly restartOnSettings = [
    NODE_EXECUTABLE_SETTING,
    'corePath',
    'trace.server',
  ];

  #context: StackContext | undefined;
  #logger: Logger | undefined;
  #runtimeManager: RuntimeManager | undefined;
  /** The detection gate: a folder lints only while the snapshot lights it. */
  #snapshot: DetectionSnapshot | undefined;
  readonly #subscriptions: vscode.Disposable[] = [];
  readonly #folderStates = new Map<string, FolderStates>();
  #disposed = false;

  async register(context: StackContext): Promise<Record<string, unknown>> {
    this.#context = context;
    this.#snapshot = context.detection;
    this.#logger = new Logger(context.output);

    this.startRuntimeManager();

    this.#subscriptions.push(
      context.onDidChangeDetection((snapshot) => {
        this.#snapshot = snapshot;
        this.pruneDepartedFolders();
        // A detection pass fires on config topology and lockfile changes —
        // exactly the moments a document's core may have appeared, moved or
        // changed ownership. This replaces the coordinator's `retryFailedRoots`.
        this.reconcileOpenDocuments('detection change');
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.pruneDepartedFolders();
        this.reconcileOpenDocuments('workspace-folder change');
      }),
      vscode.workspace.onDidOpenTextDocument((document) => {
        const manager = this.#runtimeManager;
        if (!manager) return;
        void manager.reconcile(document).catch((error: unknown) => {
          this.#logger?.error(
            `Failed to open ${document.uri} with Rslint`,
            error,
          );
        });
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.#runtimeManager?.documentClosed(document);
      }),
    );

    const topologyWatcher =
      vscode.workspace.createFileSystemWatcher(CORE_TOPOLOGY_GLOB);
    const onTopologyChange = () => {
      this.reconcileOpenDocuments('dependency change');
    };
    this.#subscriptions.push(
      topologyWatcher,
      topologyWatcher.onDidCreate(onTopologyChange),
      topologyWatcher.onDidChange(onTopologyChange),
      topologyWatcher.onDidDelete(onTopologyChange),
    );

    this.publishStatus();
    // Adaptation #1: activation must not wait for a language server. Documents
    // already open are reconciled in the background; failures surface per
    // folder through the status reporter.
    this.#runtimeManager?.initialize(vscode.workspace.textDocuments);
    return this.buildExports();
  }

  /**
   * Published through the extension's public exports channel
   * (`RstackExtensionExports.whenStackActive('rslint')`). The E2E harness uses
   * it as the "the shell registered the lint stack" signal: it resolves once
   * this controller has registered its detected folders and scheduled the open
   * documents — a folder holding no runtime yet (idle) counts as active, since
   * a runtime only exists while a document uses one. Suites that need a live
   * server open a document and await diagnostics.
   *
   * The state snapshots are exposed for assertions and debugging; they are not
   * a stable API.
   */
  private buildExports(): Record<string, unknown> {
    return {
      stackId: this.id,
      getFolderStates: (): ReadonlyMap<string, StackState> =>
        new Map(
          this.detectedFolders().map((entry) => [
            folderKeyOf(entry.folder),
            this.folderState(folderKeyOf(entry.folder)),
          ]),
        ),
      /** Live Lint runtimes across all folders, by runtime key. */
      getRuntimeStates: (): ReadonlyMap<string, StackState> =>
        new Map(
          [...this.#folderStates.values()].flatMap((states) => [
            ...states.runtimes,
          ]),
        ),
    };
  }

  private startRuntimeManager(): void {
    const context = this.#context;
    const logger = this.#logger;
    if (!context || !logger || this.#disposed) {
      return;
    }
    const router = new WorkspaceDocumentRouter();
    this.#runtimeManager = new RuntimeManager(
      router,
      new CoreResolver(),
      (resolved) => this.createRuntime(router, context, logger, resolved),
      logger,
      {
        folderMode: (folder) => this.folderMode(folder),
        onDocumentFailure: ({ document, workspaceFolder, error }) => {
          // Last-good semantics: the document keeps whatever runtime it had.
          // The failure is still the folder's worst news, so it is folded in
          // beside the runtimes rather than shown as a toast.
          this.setState(
            folderKeyOf(workspaceFolder),
            'failures',
            document.uri.toString(),
            statusForRslintStartFailure(error),
          );
        },
        onDocumentSettled: (document) => {
          this.clearState('failures', document.uri.toString());
        },
        onRuntimeClosed: (resolved) => {
          this.clearState('runtimes', resolved.key);
        },
      },
    );
  }

  private createRuntime(
    router: WorkspaceDocumentRouter,
    context: StackContext,
    logger: Logger,
    resolved: ResolvedCoreRuntime,
  ): Rslint {
    const { workspaceFolder, installation } = resolved;
    const folderKey = folderKeyOf(workspaceFolder);
    this.setState(folderKey, 'runtimes', resolved.key, { kind: 'starting' });
    return new Rslint({
      rootKey: resolved.key,
      workspaceFolder,
      installation,
      outputChannel: context.output,
      // The extension is capped at four output channels, so the LSP trace
      // shares the stack's channel instead of opening a fifth.
      lspOutputChannel: context.output,
      router,
      logger: logger.forScope(
        `${workspaceFolder.name} @rslint/core ${installation.version ?? 'unknown'}`,
      ),
      reportStatus: (state) => {
        this.setState(
          folderKey,
          'runtimes',
          resolved.key,
          attributeToCore(state, installation.packageDirectory),
        );
      },
    });
  }

  private detectedFolders() {
    return (this.#snapshot?.foldersFor('rslint') ?? []).filter(
      (entry) => entry.stacks.rslint.mode !== undefined,
    );
  }

  private folderMode(folder: vscode.WorkspaceFolder): RslintMode | undefined {
    return this.#snapshot?.forFolder(folder)?.stacks.rslint.mode;
  }

  /** Drops the states of folders detection no longer lights. */
  private pruneDepartedFolders(): void {
    if (this.#disposed) return;
    const detected = new Set(
      this.detectedFolders().map((entry) => folderKeyOf(entry.folder)),
    );
    for (const folderKey of [...this.#folderStates.keys()]) {
      if (!detected.has(folderKey)) this.#folderStates.delete(folderKey);
    }
    this.publishStatus();
  }

  private reconcileOpenDocuments(reason: string): void {
    const manager = this.#runtimeManager;
    if (!manager || this.#disposed) return;
    manager.clearResolutionCache();
    void manager.reconcileOpenDocuments().catch((error: unknown) => {
      this.#logger?.error(
        `Failed to reconcile Rslint runtimes after ${reason}`,
        error,
      );
    });
  }

  private setState(
    folderKey: string,
    bucket: keyof FolderStates,
    key: string,
    state: StackState,
  ): void {
    if (this.#disposed) return;
    let states = this.#folderStates.get(folderKey);
    if (!states) {
      states = { runtimes: new Map(), failures: new Map() };
      this.#folderStates.set(folderKey, states);
    }
    states[bucket].set(key, state);
    this.publishStatus();
  }

  private clearState(bucket: keyof FolderStates, key: string): void {
    if (this.#disposed) return;
    for (const states of this.#folderStates.values()) {
      if (states[bucket].delete(key)) {
        this.publishStatus();
        return;
      }
    }
  }

  private folderState(folderKey: string): StackState {
    const states = this.#folderStates.get(folderKey);
    return foldRslintFolderState(
      states ? [...states.runtimes.values(), ...states.failures.values()] : [],
    );
  }

  private publishStatus(): void {
    const context = this.#context;
    if (!context || this.#disposed) {
      return;
    }
    context.status.report(
      aggregateFolderStates(
        this.detectedFolders().map((entry) => ({
          name: entry.folder.name,
          state: this.folderState(folderKeyOf(entry.folder)),
        })),
      ),
    );
  }

  private async closeRuntimeManager(): Promise<void> {
    const manager = this.#runtimeManager;
    this.#runtimeManager = undefined;
    if (!manager) {
      return;
    }
    try {
      await manager.close();
    } catch (error) {
      this.#logger?.error('Failed to close the Rslint runtime manager', error);
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const subscription of this.#subscriptions.splice(0)) {
      subscription.dispose();
    }
    await this.closeRuntimeManager();
    this.#folderStates.clear();
    this.#logger = undefined;
    this.#context = undefined;
    this.#snapshot = undefined;
  }
}

export const createRslintController = (): StackController =>
  new RslintController();
