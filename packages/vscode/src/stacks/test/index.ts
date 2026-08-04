import vscode from 'vscode';
import type {
  DetectionSnapshot,
  StackContext,
  StackController,
} from '../../types';
import { RstestDiagnostics } from './diagnostics';
import { TestErrorStore, testMessageText } from './errorStore';
import { logger } from './logger';
import { runningWorkers } from './master';
import { Project, WorkspaceManager } from './project';
import { status } from './status';
import { disposeTerminal } from './terminal';
import { RstestFileCoverage } from './testRunReporter';
import {
  gatherTestItems,
  ProjectFolder,
  TestCase,
  TestFile,
  TestFolder,
  testData,
} from './testTree';

/**
 * The `TestController` id. Every `controllerId == 'rstack.rstest'` `when`
 * clause in `package.json` keys off it (the namespace adaptation).
 */
export const TEST_CONTROLLER_ID = 'rstack.rstest';

/** Context key backing the `resourcePath in ...` menu clauses. */
const TEST_FILES_CONTEXT_KEY = 'rstack.rstest.testFiles';

/**
 * The copy of `rstest/packages/vscode`'s `Rstest` class (upstream
 * `src/extension.ts`), with the mandatory port adaptations:
 *
 * 1. **Activation** — upstream constructed this from `activate()` and pushed
 *    everything onto `ExtensionContext#subscriptions`. Here the shell owns
 *    activation and can register/unregister the stack many times in one session
 *    (a gate flip, a trust grant, a folder losing its last config), so every
 *    disposable is owned by this instance and released in `dispose()`.
 *    `ExtensionContext#subscriptions` is never touched — a second `register()`
 *    would otherwise fail with "command already exists".
 * 2. **Namespace** — controller id, command ids and the context key are
 *    `rstack.rstest.*`.
 * 4. **Status** — no own status UI; `context.status` is bound to the module
 *    singleton the deep call sites (`master.ts`, `bridge.ts`) report through,
 *    and `context.output` is bound to the shell-owned channel `logger` writes
 *    into. Upstream disposed the channel here; this one is not ours to dispose.
 *
 * Detection also scopes the scan: only folders in which the shell detected
 * Rstest get a `WorkspaceManager`, and each manager is handed the folder's
 * `rstack.config.*` files so it can synthesize bridged projects.
 */
class Rstest implements vscode.Disposable {
  private ctrl: vscode.TestController;
  private workspaces = new Map<string, WorkspaceManager>();
  private disposables: vscode.Disposable[] = [];
  private diagnostics = new RstestDiagnostics();
  private errorStore = new TestErrorStore();
  private detection: DetectionSnapshot;
  private runProfile!: vscode.TestRunProfile;
  private coverageProfile!: vscode.TestRunProfile;
  private disposed = false;

  // Kept for parity with upstream, where the E2E suites reach the tree through
  // `extension.exports.testController`.
  get testController() {
    return this.ctrl;
  }

  /**
   * What upstream's `activate()` effectively exported (the `Rstest` instance):
   * the E2E suites (`tests/e2e/rstest/`) consume `testController`, `runProfile`
   * and `startTestRun`. The shell republishes this object through the
   * extension's public exports (`RstackExtensionExports.whenStackActive`).
   * All three values are stable for the lifetime of one registration; a
   * re-registration publishes a fresh object.
   */
  buildExports(): Record<string, unknown> {
    return {
      testController: this.ctrl,
      runProfile: this.runProfile,
      startTestRun: this.startTestRun,
    };
  }

  constructor(private context: StackContext) {
    this.detection = context.detection;
    this.ctrl = vscode.tests.createTestController(TEST_CONTROLLER_ID, 'Rstest');
    this.disposables.push(this.ctrl, this.diagnostics);

    this.setupTestController();
    this.startScanWorkspaces();

    this.disposables.push(
      context.onDidChangeDetection((snapshot) => {
        this.detection = snapshot;
        this.applyDetection();
      }),
    );
  }

  private setupTestController() {
    this.ctrl.refreshHandler = () => this.startScanWorkspaces();

    this.runProfile = this.ctrl.createRunProfile(
      'Run Tests',
      vscode.TestRunProfileKind.Run,
      this.startTestRun,
      true,
      undefined,
      true,
    );

    this.disposables.push(
      vscode.commands.registerCommand(
        'rstack.rstest.updateSnapshot',
        (params: { test: vscode.TestItem; message: vscode.TestMessage }) => {
          const cancellation = new vscode.CancellationTokenSource();
          return this.startTestRun(
            new vscode.TestRunRequest(
              [params.test],
              undefined,
              this.runProfile,
            ),
            cancellation.token,
            true,
          ).finally(() => cancellation.dispose());
        },
      ),
    );

    this.registerCommands();

    this.ctrl.createRunProfile(
      'Debug Tests',
      vscode.TestRunProfileKind.Debug,
      this.startTestRun,
      true,
      undefined,
      true,
    );

    this.coverageProfile = this.ctrl.createRunProfile(
      'Run Tests with Coverage',
      vscode.TestRunProfileKind.Coverage,
      this.startTestRun,
      true,
      undefined,
      true,
    );

    this.coverageProfile.loadDetailedCoverage = async (_testRun, coverage) => {
      if (coverage instanceof RstestFileCoverage) {
        return coverage.details;
      }
      return [];
    };
  }

  private registerCommands() {
    const register = (
      command: string,
      callback: (...args: any[]) => unknown,
    ) => {
      this.disposables.push(vscode.commands.registerCommand(command, callback));
    };

    // Upstream's `rstest.openOutput` is gone: the shell owns the four output
    // channels and registers `rstack.rstest.output.focus`.

    register('rstack.rstest.revealInTestExplorer', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      const item = target && this.findTestFileItem(target);
      if (!item) {
        vscode.window.showInformationMessage(
          'This file is not a known Rstest test file.',
        );
        return;
      }
      await vscode.commands.executeCommand('vscode.revealTestInExplorer', item);
    });

    register(
      'rstack.rstest.copyErrorOutput',
      async (args?: { test: vscode.TestItem; message: vscode.TestMessage }) => {
        if (!args?.message) return;
        await vscode.env.clipboard.writeText(testMessageText(args.message));
      },
    );

    register('rstack.rstest.runInTerminal', (testItem?: vscode.TestItem) => {
      if (!testItem) return;
      const data = testData.get(testItem);
      if (data instanceof TestCase) {
        data.api.runInTerminal({
          fileFilter: data.uri.fsPath,
          testCaseNamePath: data.parentNames.concat(testItem.label),
          isSuite: data.type === 'suite',
        });
      } else if (data instanceof TestFile || data instanceof TestFolder) {
        data.api.runInTerminal({ fileFilter: data.uri.fsPath });
      } else if (data instanceof Project) {
        data.api.runInTerminal({});
      } else {
        vscode.window.showInformationMessage(
          'Run in Terminal is not available for this item.',
        );
      }
    });

    register(
      'rstack.rstest.copyTestItemErrors',
      async (testItem?: vscode.TestItem) => {
        if (!testItem) return;
        const errors = this.collectErrors(testItem);
        if (!errors.length) {
          vscode.window.showInformationMessage('No test errors to copy.');
          return;
        }
        await vscode.env.clipboard.writeText(errors.join('\n\n'));
      },
    );
  }

  // Errors for a test item plus any descendants (a file/suite item aggregates
  // its leaves' failures).
  private collectErrors(item: vscode.TestItem): string[] {
    const errors: string[] = [];
    for (const test of [item, ...gatherTestItems(item.children)]) {
      for (const message of this.errorStore.get(test)) {
        errors.push(testMessageText(message));
      }
    }
    return errors;
  }

  private findTestFileItem(uri: vscode.Uri): vscode.TestItem | undefined {
    const key = uri.toString();
    for (const workspace of this.workspaces.values()) {
      for (const project of workspace.projects.values()) {
        const item = project.testFiles.get(key)?.testItem;
        if (item) return item;
      }
    }
    return undefined;
  }

  private updateTestFilesContext() {
    const paths: string[] = [];
    for (const workspace of this.workspaces.values()) {
      for (const project of workspace.projects.values()) {
        for (const file of project.testFiles.values()) {
          paths.push(file.uri.fsPath);
        }
      }
    }
    vscode.commands.executeCommand('setContext', TEST_FILES_CONTEXT_KEY, paths);
  }

  /**
   * The folders Rstest was detected in (detection enables a stack
   * per folder). Virtual file systems are skipped, as upstream did — the worker
   * spawn and the package resolution both need a real path.
   */
  private detectedFolders(): vscode.WorkspaceFolder[] {
    return this.detection
      .foldersFor('rstest')
      .map((entry) => entry.folder)
      .filter((folder) => folder.uri.scheme === 'file');
  }

  private rstackConfigFilesOf(
    folder: vscode.WorkspaceFolder,
  ): readonly vscode.Uri[] {
    return (
      this.detection.forFolder(folder)?.stacks.rstest.rstackConfigFiles ?? []
    );
  }

  /**
   * Full rescan. Bound to `refreshHandler`, so it must be safe to call at any
   * time: every manager is torn down and rebuilt from the current snapshot.
   */
  private startScanWorkspaces() {
    // dispose previous data on refresh
    for (const [workspacePath, workspace] of this.workspaces) {
      workspace.dispose();
      this.workspaces.delete(workspacePath);
    }
    // collect all detected workspaces
    for (const folder of this.detectedFolders()) {
      this.handleAddWorkspace(folder);
    }
    this.refreshAllWorkspaces();
  }

  /**
   * Incremental reconcile against a fresh detection snapshot. Folders that kept
   * their detection state keep their `WorkspaceManager` (and therefore their
   * warm workers); only the `rstack.config.*` list is pushed down, because a
   * config appearing or disappearing changes which projects are bridged.
   *
   * Upstream watched `onDidChangeWorkspaceFolders` itself; the shell's
   * detection service already does (folder identity is part of its snapshot
   * signature), so this one event covers both.
   */
  private applyDetection() {
    if (this.disposed) return;
    const detected = this.detectedFolders();
    const wanted = new Set(detected.map((folder) => folder.uri.toString()));

    for (const [key, workspace] of this.workspaces) {
      if (!wanted.has(key)) {
        workspace.dispose();
        this.workspaces.delete(key);
      }
    }
    for (const folder of detected) {
      const key = folder.uri.toString();
      const existing = this.workspaces.get(key);
      if (existing) {
        existing.setRstackConfigFiles(this.rstackConfigFilesOf(folder));
        // The detection pass may have been lockfile-driven: dependencies that
        // were missing when a project's config first evaluated may exist now.
        existing.retryFailedProjects();
      } else {
        this.handleAddWorkspace(folder);
      }
    }
    this.refreshAllWorkspaces();
  }

  private handleAddWorkspace(workspaceFolder: vscode.WorkspaceFolder) {
    // ignore virtual file system
    if (workspaceFolder.uri.scheme !== 'file') return;

    this.workspaces.set(
      workspaceFolder.uri.toString(),
      new WorkspaceManager(
        workspaceFolder,
        this.ctrl,
        this.rstackConfigFilesOf(workspaceFolder),
        () => this.updateTestFilesContext(),
      ),
    );
  }

  private refreshAllWorkspaces() {
    this.ctrl.items.replace([]);
    for (const workspace of this.workspaces.values()) {
      // Upstream keyed this off `workspace.workspaceFolders.length`. Detection
      // can leave a multi-folder workspace with a single Rstest folder, and
      // wrapping a lone folder in a node it does not need is worse than the
      // upstream behavior it replaces.
      workspace.refresh(this.workspaces.size === 1);
    }
    this.updateTestFilesContext();
    this.reportStatus();
  }

  private reportStatus() {
    const folders = this.workspaces.size;
    if (folders === 0) {
      // Detection said yes for at least one folder or the shell would not have
      // registered us; landing here means every one of them is virtual.
      status.starting('no local workspace folder to scan');
      return;
    }
    status.running(
      folders === 1 ? '1 workspace folder' : `${folders} workspace folders`,
    );
  }

  private startTestRun = async (
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    updateSnapshot?: boolean,
    // used by e2e tests
    createTestRun = this.ctrl.createTestRun.bind(this.ctrl),
  ) => {
    const run = createTestRun(request);
    const enqueuedTests = (tests: readonly vscode.TestItem[]) => {
      for (const test of tests) {
        if (request.exclude?.includes(test)) {
          continue;
        }
        const data = testData.get(test);
        if (data instanceof TestFile || data instanceof TestCase) {
          run.enqueued(test);
        }
        enqueuedTests(gatherTestItems(test.children, false));
      }
    };

    enqueuedTests(request.include ?? gatherTestItems(this.ctrl.items, false));

    const commonOptions = {
      run,
      token,
      updateSnapshot,
      kind: request.profile?.kind,
      continuous: request.continuous,
      diagnostics: this.diagnostics,
      errorStore: this.errorStore,
      createTestRun: () =>
        createTestRun(
          new vscode.TestRunRequest(
            request.include,
            request.exclude,
            request.profile,
            request.continuous,
            request.preserveFocus,
          ),
        ),
    };

    const discoverTests = async (tests: readonly vscode.TestItem[]) => {
      for (const test of tests) {
        if (request.exclude?.includes(test)) {
          continue;
        }

        const data = testData.get(test);
        if (data instanceof WorkspaceManager) {
          if (data.activeProjects.size === 1) {
            const project = data.activeProjects.values().next().value!;
            await project.api.runTest({
              ...commonOptions,
            });
          } else {
            await discoverTests(gatherTestItems(test.children, false));
          }
        } else if (data instanceof Project) {
          await data.api.runTest({
            ...commonOptions,
          });
        } else if (data instanceof ProjectFolder) {
          // grouping folder spans multiple projects; recurse into children
          await discoverTests(gatherTestItems(test.children, false));
        } else if (data instanceof TestFolder) {
          await data.api.runTest({
            ...commonOptions,
            fileFilter: data.uri.fsPath,
          });
        } else if (data instanceof TestFile) {
          await data.api.runTest({
            ...commonOptions,
            fileFilter: data.uri.fsPath,
          });
        } else if (data instanceof TestCase) {
          await data.api.runTest({
            ...commonOptions,
            fileFilter: data.uri.fsPath,
            testCaseNamePath: data.parentNames.concat(test.label),
            isSuite: data.type === 'suite',
          });
        }
      }
    };

    try {
      if (!request.include?.length) {
        if (this.workspaces.size === 1) {
          const workspace = this.workspaces.values().next().value!;
          if (workspace.activeProjects.size === 1) {
            const project = workspace.activeProjects.values().next().value!;
            await project.api.runTest({
              ...commonOptions,
            });
            return;
          }
        }
      }
      await discoverTests(
        request.include ?? gatherTestItems(this.ctrl.items, false),
      );
    } catch (error) {
      logger.error('Error running tests:', error);
    } finally {
      run.end();
    }
  };

  dispose() {
    this.disposed = true;
    // Upstream's `deactivate()`. A worker is a child process, so it outlives a
    // plain `TestController.dispose()` and has to be closed explicitly.
    for (const worker of runningWorkers) {
      worker.$close();
    }
    disposeTerminal();
    for (const workspace of this.workspaces.values()) {
      workspace.dispose();
    }
    this.workspaces.clear();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    // The menus stay hidden until the stack comes back.
    vscode.commands.executeCommand('setContext', TEST_FILES_CONTEXT_KEY, []);
  }
}

class RstestController implements StackController {
  readonly id = 'rstest' as const;

  #rstest: Rstest | undefined;

  get testController(): vscode.TestController | undefined {
    return this.#rstest?.testController;
  }

  async register(context: StackContext): Promise<Record<string, unknown>> {
    // Both are module singletons the copied files import directly; binding them
    // here is what keeps those files diffable against upstream (adaptation #4).
    logger.bind(context.output);
    status.bind(context.status);
    status.starting('scanning workspace folders');
    try {
      this.#rstest = new Rstest(context);
    } catch (error) {
      logger.unbind();
      status.unbind();
      throw error;
    }
    return this.#rstest.buildExports();
  }

  dispose(): void {
    this.#rstest?.dispose();
    this.#rstest = undefined;
    status.unbind();
    logger.unbind();
  }
}

export const createRstestController = (): StackController =>
  new RstestController();
