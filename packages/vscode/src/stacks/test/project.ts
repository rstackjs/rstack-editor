import path from 'node:path';
import type { TestInfo } from '@rstest/core';
import picomatch from 'picomatch';
import { glob } from 'tinyglobby';
import vscode from 'vscode';
import { RSTACK_CONFIG_NAMES } from '../../detection';
import { resolveRstackShim } from './bridge';
import { watchConfigValue } from './config';
import { ReportedRstestResolutionError } from './coreResolution';
import { logger } from './logger';
import { RstestApi } from './master';
import { type ChildProjectRef, computeCoveredConfigs } from './projectCoverage';
import { status } from './status';
import { ProjectFolder, TestFile, TestFolder, testData } from './testTree';

// The default config file name at the workspace root. A lone project using it
// is shown without a project node (its test files sit directly under the root).
// `rstack.config.*` is included because the rstack bridge makes it an
// equally first-class root config: an rstack-cli user with a single
// `rstack.config.ts` should get the same node-less layout as one with a single
// `rstest.config.ts`.
const DEFAULT_ROOT_CONFIG_RE = /^(?:rstest|rstack)\.config\.[mc]?[tj]s$/;

/**
 * Where a `Project`'s config comes from. The worker-cwd decoupling adaptation
 * plus the rstack bridge are both expressed here: upstream had only a config
 * file URI and derived everything else from its directory.
 */
export type ProjectSource = {
  /**
   * The config file the *user* owns, and the `Project`'s identity inside its
   * `WorkspaceManager`. Also what the project tree lays out and labels by. For
   * a native project this is the `rstest.config.*`; for a bridged one the
   * `rstack.config.*` — never the shim, which lives under `node_modules` and
   * would produce a nonsensical tree label and a key shared by every bridged
   * project in the folder.
   */
  readonly sourceUri: vscode.Uri;
  /**
   * The config file handed to Rstest (`-c` / `initCli({ config })`). Defaults
   * to `sourceUri`; differs only for the rstack bridge, where it is
   * `<rstack>/dist/rstestConfig.js`.
   */
  readonly configFileUri?: vscode.Uri;
  /**
   * The worker spawn cwd. Defaults to `dirname(configFileUri)` — byte-identical
   * to upstream for a native config. The bridge sets it to the
   * `rstack.config.*` directory so the shim's single-directory, no-parent-walk
   * `loadRstackConfig()` probe finds the config.
   */
  readonly cwd?: string;
  /**
   * The default `@rstest/core` and CLI package-resolution anchor. Defaults to
   * `cwd`; the bridge sets it to the already-resolved `rstack` package root so
   * rstack's dependency is visible in isolated `node_modules` layouts.
   */
  readonly rstestResolutionDir?: string;
  /** True for a `Project` synthesized by the rstack bridge. */
  readonly isBridge?: boolean;
};

export class WorkspaceManager implements vscode.Disposable {
  public projects = new Map<string, Project>();
  // The subset of `projects` currently shown (not suppressed as a duplicate of
  // an aggregating parent). Kept in sync by `refreshAllProject`. Run All uses
  // this rather than `projects` so it runs the same set the tree displays.
  public activeProjects = new Map<string, Project>();
  private workspacePath: string;
  private testItem?: vscode.TestItem;
  private configValueWatcher: vscode.Disposable;
  // `rstack.config.*` files governing this folder, supplied by the shell's
  // detection pass (the discovery glob below excludes `node_modules`, and
  // `rstack.config.*` is not part of it anyway).
  private rstackConfigFiles: readonly vscode.Uri[] = [];
  // Directories whose shim resolution already failed and was reported, so a
  // project without `rstack` installed does not re-log on every tree refresh.
  private reportedShimFailures = new Set<string>();
  // The config-file glob scan is asynchronous, and `refresh()` can run before it
  // settles. Bridged projects must not be synthesized against an
  // "I found no native config yet" that is really "I have not looked yet" —
  // each `Project` spawns a worker in its constructor, so the wrong answer
  // costs a process, not just a tree node.
  private didScanConfigFiles = false;
  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    private testController: vscode.TestController,
    rstackConfigFiles: readonly vscode.Uri[] = [],
    private onDidChangeTestFiles?: () => void,
  ) {
    this.workspacePath = workspaceFolder.uri.toString();
    this.rstackConfigFiles = rstackConfigFiles;
    this.configValueWatcher = this.startWatchingWorkspace();
  }
  // if this is the only one workspace, skip create test item
  public refresh(isOnlyOne: boolean) {
    if (isOnlyOne) {
      if (this.testItem) {
        this.testItem = undefined;
      }
    } else {
      if (!this.testItem) {
        this.testItem = this.testController.createTestItem(
          this.workspacePath,
          this.workspaceFolder.name,
          this.workspaceFolder.uri,
        );
        testData.set(this.testItem, this);
      }
      this.testController.items.add(this.testItem);
    }
    this.refreshAllProject();
  }
  /**
   * Called by the stack controller whenever the shell's detection snapshot
   * changes. A folder that gains or loses its `rstack.config.*` re-synthesizes
   * (or drops) its bridged projects without a window reload.
   */
  public setRstackConfigFiles(files: readonly vscode.Uri[]) {
    const signature = (uris: readonly vscode.Uri[]) =>
      uris
        .map((uri) => uri.toString())
        .sort()
        .join('\n');
    if (signature(files) === signature(this.rstackConfigFiles)) return;
    this.rstackConfigFiles = files;
    this.refreshAllProject();
  }
  public dispose() {
    for (const project of this.projects.values()) {
      project.dispose();
    }
    // A failed shim resolution latches a mismatch without ever creating a
    // project, so no `Project.dispose` will clear it when the folder goes.
    for (const cwd of this.reportedShimFailures) {
      status.forget(cwd);
    }
    this.configValueWatcher.dispose();
  }
  private startWatchingWorkspace() {
    return watchConfigValue(
      'configFileGlobPattern',
      this.workspaceFolder,
      async (globs, token) => {
        const patterns = globs.map(
          (glob) => new vscode.RelativePattern(this.workspaceFolder, glob),
        );

        // find all config file
        const files = (
          await Promise.all(
            patterns.map((pattern) =>
              vscode.workspace.findFiles(
                pattern,
                '**/node_modules/**',
                undefined,
                token,
              ),
            ),
          )
        ).flat();

        const visited = new Set<string>();
        for (const file of files) {
          this.handleAddConfigFile(file);
          visited.add(file.toString());
        }
        // remove outdated items after glob configuration changed
        for (const [configFilePath, project] of this.projects) {
          if (project.isBridge) continue;
          if (!visited.has(configFilePath)) {
            project.dispose();
            this.projects.delete(configFilePath);
          }
        }
        this.didScanConfigFiles = true;
        this.refreshAllProject();

        // start watching config file create and delete event
        for (const pattern of patterns) {
          const watcher = vscode.workspace.createFileSystemWatcher(
            pattern,
            false,
            false,
            false,
          );
          token.onCancellationRequested(() => watcher.dispose());
          watcher.onDidCreate((file) => {
            this.handleAddConfigFile(file);
            this.refreshAllProject();
          });
          watcher.onDidDelete((file) => {
            this.handleRemoveConfigFile(file);
            this.refreshAllProject();
          });
          watcher.onDidChange((file) => {
            this.handleRemoveConfigFile(file);
            this.handleAddConfigFile(file);
            this.refreshAllProject();
          });
        }

        // Content edits to a `rstack.config.*` change neither the detection
        // snapshot (it records paths only) nor the shim file Rstest actually
        // loads, so without this watcher nothing would re-evaluate
        // `define.test()` for a bridged project until a reload. Rebuild the
        // project on change; create/delete arrive through the shell's
        // detection events (`setRstackConfigFiles`) instead.
        const rstackWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            this.workspaceFolder,
            `**/{${RSTACK_CONFIG_NAMES.join(',')}}`,
          ),
          true,
          false,
          true,
        );
        token.onCancellationRequested(() => rstackWatcher.dispose());
        rstackWatcher.onDidChange((file) => {
          const key = file.toString();
          if (!this.projects.get(key)?.isBridge) return;
          this.handleRemoveConfigFile(file);
          // `refreshAllProject` → `syncBridgeProjects` re-resolves the shim
          // and recreates the project with a fresh config evaluation.
          this.refreshAllProject();
        });
      },
    );
  }
  /**
   * Recreates projects whose one-shot config evaluation failed — dependencies
   * may have been installed since (observed as a lockfile-driven detection
   * pass). Only ever called from a detection event, never from a project
   * callback, so a persistently failing config cannot recreate itself in a
   * loop; it is simply re-attempted once per detection pass.
   */
  public retryFailedProjects() {
    for (const [key, project] of [...this.projects]) {
      if (!project.configLoadFailed) continue;
      project.dispose();
      this.projects.set(key, this.createProject(project.source));
    }
  }

  private handleAddConfigFile(configFileUri: vscode.Uri) {
    const configFilePath = configFileUri.toString();
    if (this.projects.has(configFilePath)) return;
    this.projects.set(
      configFilePath,
      this.createProject({ sourceUri: configFileUri }),
    );
  }
  private handleRemoveConfigFile(configFileUri: vscode.Uri) {
    const configFilePath = configFileUri.toString();
    const project = this.projects.get(configFilePath);
    if (!project) return;
    project.dispose();
    this.projects.delete(configFilePath);
  }
  private createProject(source: ProjectSource): Project {
    return new Project(
      this.workspaceFolder,
      source,
      this.testController,
      this.testItem?.children ?? this.testController.items,
      this.onDidChangeTestFiles,
      // Re-render once the config resolves: coverage (which project aggregates
      // which) is only known then, and it decides which projects to show.
      () => this.refreshAllProject(),
    );
  }

  /**
   * The rstack bridge: when a folder is governed by
   * `rstack.config.*` and has **no** tool-native config, synthesize a `Project`
   * per `rstack.config.*` whose config file is rstack's shipped Rstest shim and
   * whose cwd is the config's own directory. Its package-resolution anchor is
   * the resolved `rstack` directory, where rstack's Rstest dependency lives.
   *
   * A native `rstest.config.*` wins **at its own root**: rstack's own
   * `rs test` would load the shim, which reads `define.test()`, but a
   * directory that ships both configs has deliberately opted into the
   * tool-native one, and running the same tests through two projects would
   * duplicate the tree. A native config elsewhere in the workspace folder
   * (e.g. a sibling monorepo package) says nothing about this root and must
   * not suppress its bridge.
   *
   * The shim is re-resolved on **every** sync, including for live bridges: a
   * dependency change (observed as a lockfile-driven detection pass) can move
   * the version-pinned store path the project was created with, or swap the
   * installed version entirely. A bridge whose shim still resolves to the
   * same file is kept as-is — its warm worker is not churned — and rebuilt
   * only when the resolution actually moved or stopped resolving.
   */
  private syncBridgeProjects() {
    if (!this.didScanConfigFiles) return;

    const nativeProjectDirs = new Set(
      [...this.projects.values()]
        .filter((project) => !project.isBridge)
        .map((project) => path.dirname(project.sourceUri.fsPath)),
    );

    // One bridge per directory, not per file: the shim probes the default
    // config names in its cwd itself and never receives the source path, so
    // sibling names (e.g. `rstack.config.ts` next to `rstack.config.js`
    // mid-migration) would all load the same winning config and duplicate its
    // tests. Keep the file the shim will actually pick — RSTACK_CONFIG_NAMES
    // mirrors rstack's own probe order.
    const precedenceOf = (uri: vscode.Uri): number =>
      (RSTACK_CONFIG_NAMES as readonly string[]).indexOf(
        path.basename(uri.fsPath),
      );
    const winnerByDir = new Map<string, vscode.Uri>();
    for (const rstackConfig of this.rstackConfigFiles) {
      const dir = path.dirname(rstackConfig.fsPath);
      const current = winnerByDir.get(dir);
      if (!current || precedenceOf(rstackConfig) < precedenceOf(current)) {
        winnerByDir.set(dir, rstackConfig);
      }
    }

    const candidateDirs = new Set<string>();
    const wanted = new Map<string, ProjectSource>();
    for (const [cwd, rstackConfig] of winnerByDir) {
      const key = rstackConfig.toString();
      if (nativeProjectDirs.has(cwd)) continue;
      candidateDirs.add(cwd);
      const shim = resolveRstackShim(cwd, {
        silent: this.reportedShimFailures.has(cwd),
      });
      if (!shim) {
        this.reportedShimFailures.add(cwd);
        continue;
      }
      this.reportedShimFailures.delete(cwd);
      const configFileUri = vscode.Uri.file(shim.configFilePath);
      const existing = this.projects.get(key);
      // `configFileUri` is derived from the shim's package directory, so a
      // matching shim path also means an unchanged resolution anchor.
      if (
        existing?.isBridge &&
        existing.configFileUri.toString() === configFileUri.toString()
      ) {
        wanted.set(key, { sourceUri: rstackConfig });
        continue;
      }
      if (existing?.isBridge) {
        // The shim moved: drop the stale project so the add loop below
        // recreates it against the fresh resolution.
        existing.dispose();
        this.projects.delete(key);
      }
      wanted.set(key, {
        sourceUri: rstackConfig,
        configFileUri,
        cwd,
        rstestResolutionDir: shim.packageDirectory,
        isBridge: true,
      });
      logger.info(
        `Driving Rstest from ${rstackConfig.fsPath} through the rstack config shim`,
      );
    }

    // A directory that stopped being a bridge candidate (its config was
    // removed or a native config took over) can leave a latched version
    // mismatch behind with no project whose disposal would clear it.
    for (const cwd of [...this.reportedShimFailures]) {
      if (candidateDirs.has(cwd)) continue;
      this.reportedShimFailures.delete(cwd);
      status.forget(cwd);
    }

    for (const [key, project] of this.projects) {
      if (project.isBridge && !wanted.has(key)) {
        project.dispose();
        this.projects.delete(key);
      }
    }
    for (const [key, source] of wanted) {
      if (this.projects.has(key)) continue;
      this.projects.set(key, this.createProject(source));
    }
  }

  private refreshAllProject() {
    this.syncBridgeProjects();

    const collection = this.testItem?.children ?? this.testController.items;
    collection.replace([]);

    const activeProjects = this.resolveActiveProjects();
    this.activeProjects = activeProjects;

    // Standard single-project setup (one project using the default config name
    // at the workspace root): show its test files directly, with no project node.
    if (activeProjects.size === 1) {
      const [[, project]] = activeProjects;
      const relative = path.relative(
        this.workspaceFolder.uri.fsPath,
        project.sourceUri.fsPath,
      );
      if (DEFAULT_ROOT_CONFIG_RE.test(relative)) {
        project.refresh(collection, null);
        return;
      }
    }

    this.buildProjectTree(collection, activeProjects);
  }

  // A config file aggregated by *another* project via `projects` is shown only
  // under that parent; suppress the standalone copy so its test files are not
  // duplicated. `this.projects` is keyed by URI string, while matching uses
  // fs paths.
  private resolveActiveProjects(): Map<string, Project> {
    const entries = [...this.projects];
    const covered = computeCoveredConfigs(
      entries.map(([uri, project]) => ({
        key: uri,
        // The path Core reports for this project in another project's
        // `childProjects`, i.e. the config file actually loaded — the shim for
        // a bridged project, not the map key.
        configFilePath: project.configFilePath,
        root: project.root.fsPath,
        childProjects: project.childProjects,
        include: project.include,
      })),
    );

    const activeProjects = new Map<string, Project>();
    for (const [uri, project] of entries) {
      const isCovered = covered.has(uri);
      project.setSuppressed(isCovered);
      if (!isCovered) {
        activeProjects.set(uri, project);
      }
    }
    return activeProjects;
  }

  // Group projects into a folder tree by their config file directory, so the
  // project level nests like the file level instead of showing a flat list of
  // `dir/rstest.config.ts` entries. A project is shown as its own directory
  // (e.g. `packages/core`); the config file name is only used to disambiguate
  // a root-level config or multiple configs sharing one directory.
  private buildProjectTree(
    rootCollection: vscode.TestItemCollection,
    projects: Map<string, Project>,
  ) {
    type TreeNode = { children: Map<string, TreeNode>; project?: Project };
    const root: TreeNode = { children: new Map() };

    for (const project of projects.values()) {
      const relative = path.relative(
        this.workspaceFolder.uri.fsPath,
        project.sourceUri.fsPath,
      );
      let node = root;
      for (const segment of relative.split(path.sep)) {
        let next = node.children.get(segment);
        if (!next) {
          next = { children: new Map() };
          node.children.set(segment, next);
        }
        node = next;
      }
      node.project = project;
    }

    const handleTreeItem = (
      key: string,
      node: TreeNode,
      mergedParents: string[],
      parents: string[],
      collection: vscode.TestItemCollection,
    ) => {
      const children = [...node.children];

      // Collapse single-child chains: a directory with exactly one child merges
      // into it, whether the child is another directory or the project's config
      // file, so `packages/core/rstest.config.ts` shows as one `packages/core`
      // project node.
      if (children.length === 1) {
        const [childKey, childNode] = children[0];
        handleTreeItem(
          childKey,
          childNode,
          [...mergedParents, key],
          [...parents, key],
          collection,
        );
        return;
      }

      if (node.project) {
        // The config file node: label it by its directory (mergedParents), and
        // fall back to the file name only when it has no directory of its own
        // (a root-level config, or configs sharing a directory).
        const label = mergedParents.join(path.sep) || key;
        node.project.refresh(collection, label);
        return;
      }

      const label = [...mergedParents, key].join(path.sep);
      const uri = vscode.Uri.file(
        path.join(this.workspaceFolder.uri.fsPath, ...parents, key),
      );
      const item = this.testController.createTestItem(
        uri.toString(),
        label,
        uri,
      );
      collection.add(item);
      testData.set(item, new ProjectFolder());

      for (const [childKey, childNode] of children) {
        handleTreeItem(
          childKey,
          childNode,
          [],
          [...parents, key],
          item.children,
        );
      }
    };

    for (const [key, node] of root.children) {
      handleTreeItem(key, node, [], [], rootCollection);
    }
  }
}

// There is already a concept of 'project' in rstest, so we might consider changing its name here.
export class Project implements vscode.Disposable {
  api: RstestApi;
  root: vscode.Uri;
  testItem?: vscode.TestItem;
  cancellationSource: vscode.CancellationTokenSource;
  include: string[] = [];
  exclude: string[] = [];
  testFiles = new Map<string, TestFile>();
  // Sub-projects this config aggregates via `projects`. Populated once the
  // config resolves; empty for a leaf config.
  childProjects: ChildProjectRef[] = [];
  // A project whose config file is already covered by another (aggregator)
  // project is suppressed: it neither watches files nor renders test items, so
  // the same tests are not shown twice.
  suppressed = false;
  // The one-shot config evaluation in the constructor rejected (typically:
  // dependencies not installed yet). `retryFailedProjects` recreates such
  // projects on the next detection pass.
  configLoadFailed = false;
  /** What this project was built from; `retryFailedProjects` rebuilds from it. */
  readonly source: ProjectSource;
  // See `ProjectSource`.
  readonly sourceUri: vscode.Uri;
  readonly configFileUri: vscode.Uri;
  readonly cwd: string;
  readonly rstestResolutionDir: string;
  readonly isBridge: boolean;
  #watch?: vscode.Disposable;
  constructor(
    private workspaceFolder: vscode.WorkspaceFolder,
    source: ProjectSource,
    private testController: vscode.TestController,
    public parentCollection: vscode.TestItemCollection,
    private onDidChangeTestFiles?: () => void,
    private onConfigResolved?: () => void,
  ) {
    this.source = source;
    this.sourceUri = source.sourceUri;
    this.configFileUri = source.configFileUri ?? source.sourceUri;
    // use dirname of config file as default root
    this.cwd = source.cwd ?? path.dirname(this.configFileUri.fsPath);
    this.rstestResolutionDir = source.rstestResolutionDir ?? this.cwd;
    this.isBridge = source.isBridge ?? false;
    this.root = vscode.Uri.file(this.cwd);
    this.api = new RstestApi(
      workspaceFolder,
      this.cwd,
      this.configFileUri.fsPath,
      this,
      this.rstestResolutionDir,
    );
    this.cancellationSource = new vscode.CancellationTokenSource();

    void this.api
      .getNormalizedConfig()
      .then((config) => {
        if (this.cancellationSource.token.isCancellationRequested) return;
        this.root = vscode.Uri.file(config.root);
        this.include = config.include;
        this.exclude = config.exclude;
        this.childProjects = config.childProjects;
        this.applyWatch();
        this.onConfigResolved?.();
      })
      .catch((error) => {
        if (this.cancellationSource.token.isCancellationRequested) return;
        this.configLoadFailed = true;
        if (!(error instanceof ReportedRstestResolutionError)) {
          logger.error('Failed to initialize project config', error);
        }
        // Let the manager settle its tree even when a config fails to load.
        this.onConfigResolved?.();
      });
  }

  /** The config file path Rstest is asked to load (`-c`). */
  get configFilePath(): string {
    return this.configFileUri.fsPath;
  }

  private applyWatch() {
    if (this.suppressed) return;
    if (!this.#watch) {
      this.#watch = this.startWatchingWorkspace(this.root);
    }
  }

  // Called by WorkspaceManager once it knows whether another project already
  // covers this config file.
  public setSuppressed(value: boolean) {
    if (this.suppressed === value) return;
    this.suppressed = value;
    if (value) {
      this.#watch?.dispose();
      this.#watch = undefined;
      this.testFiles.clear();
    } else {
      this.applyWatch();
    }
  }

  // `label` is the project node's label, or `null` to hoist its test files
  // directly under `parentCollection` with no project node (the standard
  // single-project case). The layout decision is owned by `WorkspaceManager`.
  public refresh(
    parentCollection: vscode.TestItemCollection,
    label: string | null,
  ) {
    this.parentCollection = parentCollection;
    if (label === null) {
      this.testItem = undefined;
    } else {
      if (!this.testItem) {
        this.testItem = this.testController.createTestItem(
          // The user-owned config file, so two bridged projects in different
          // directories do not collide on the one shim path they share.
          this.sourceUri.toString(),
          label,
          // Do not set `uri`, so that VSCode’s “Run Tests” works correctly.
          // https://github.com/microsoft/vscode/blob/3b42759b8b501e68106c72b5683dcc114ed789e1/src/vs/workbench/contrib/testing/common/testService.ts#L278-L280
        );
        testData.set(this.testItem, this);
      }
      // label may change across refreshes as the surrounding project tree
      // gains or loses siblings
      this.testItem.label = label;
      this.parentCollection.add(this.testItem);
    }
    this.buildTree();
  }
  dispose() {
    this.#watch?.dispose();
    this.api.dispose();
    this.cancellationSource.cancel();
    // This project's failures must not outlive it (config removed, folder
    // closed, bridge rebuilt). The master latches under the source URI —
    // unique to this project, so a sibling config in the same directory keeps
    // its own entries. Bridge *resolution* failures latch under the config
    // directory instead and are reconciled by `syncBridgeProjects`, not here.
    status.forget(this.sourceUri.toString());
  }
  get collection() {
    return this.testItem?.children || this.parentCollection;
  }
  private startWatchingWorkspace(root: vscode.Uri): vscode.Disposable {
    const matchInclude = picomatch(this.include);
    const matchExclude = picomatch(this.exclude);
    const isInclude = (uri: vscode.Uri) => {
      const relativePath = path.relative(root.fsPath, uri.fsPath);
      return matchInclude(relativePath) && !matchExclude(relativePath);
    };

    const watcher = watchConfigValue(
      'testCaseCollectMethod',
      this.workspaceFolder,
      async (method, token) => {
        if (this.testItem) {
          this.testItem.busy = true;
        }
        try {
          const files: { uri: vscode.Uri; tests?: TestInfo[] }[] =
            method === 'ast'
              ? // ast
                await glob(this.include, {
                  cwd: root.fsPath,
                  ignore: this.exclude,
                  absolute: true,
                  dot: true,
                  expandDirectories: false,
                }).then((files) =>
                  files.map((file) => ({ uri: vscode.Uri.file(file) })),
                )
              : // runtime
                await this.api.listTests().then((files) =>
                  files.map((file) => ({
                    uri: vscode.Uri.file(file.testPath),
                    tests: file.tests,
                  })),
                );

          if (token.isCancellationRequested) return;

          const visited = new Set<string>();
          for (const { uri, tests } of files) {
            this.updateOrCreateFile(uri, tests);
            visited.add(uri.toString());
          }

          // remove outdated items after glob configuration changed
          for (const file of this.testFiles.keys()) {
            if (!visited.has(file)) {
              this.testFiles.delete(file);
            }
          }
          this.buildTree();

          // start watching test file change
          // while createFileSystemWatcher don't support same glob syntax with tinyglobby
          // we can watch all files and filter with picomatch later
          const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(root, '**'),
          );
          token.onCancellationRequested(() => watcher.dispose());

          // TODO delay and batch run multiple files
          const updateOrCreateByRuntime = (uri: vscode.Uri) => {
            void this.api
              .listTests([uri.fsPath])
              .then((files) => {
                if (token.isCancellationRequested) return;
                for (const { testPath, tests } of files) {
                  const uri = vscode.Uri.file(testPath);
                  this.updateOrCreateFile(uri, tests);
                }
                this.buildTree();
              })
              .catch((error) => {
                if (!token.isCancellationRequested) {
                  logger.error('Failed to update runtime test list', error);
                }
              });
          };

          watcher.onDidCreate((uri) => {
            if (isInclude(uri)) {
              if (method === 'ast') {
                this.updateOrCreateFile(uri);
                this.buildTree();
              } else {
                updateOrCreateByRuntime(uri);
              }
            }
          });
          watcher.onDidChange((uri) => {
            if (isInclude(uri)) {
              if (method === 'ast') {
                this.updateOrCreateFile(uri);
                this.buildTree();
              } else {
                updateOrCreateByRuntime(uri);
              }
            }
          });
          watcher.onDidDelete((uri) => {
            if (isInclude(uri)) {
              this.testFiles.delete(uri.toString());
              this.buildTree();
            }
          });
        } catch (error) {
          if (!token.isCancellationRequested) {
            logger.error('Failed to collect test files', error);
          }
        } finally {
          if (this.testItem) {
            this.testItem.busy = false;
          }
        }
      },
    );
    return watcher;
  }
  // TODO pass cancellation token to updateFromDisk
  private updateOrCreateFile(uri: vscode.Uri, tests?: TestInfo[]) {
    let data = this.testFiles.get(uri.toString());
    if (!data) {
      data = new TestFile(this.api, uri, this.testController);
      this.testFiles.set(uri.toString(), data);
    }
    if (tests) {
      data.updateFromList(tests);
    } else {
      data.updateFromDisk();
    }
  }

  private buildTree() {
    // A suppressed project must not render into its collection; its config file
    // is already covered by an aggregator project.
    if (this.suppressed) return;

    type NestedRecord = { [K: string]: NestedRecord };

    const tree: NestedRecord = {};
    for (const [uriString] of this.testFiles) {
      path
        .relative(this.root.fsPath, vscode.Uri.parse(uriString).fsPath)
        .split(path.sep)
        .reduce((tree, segment) => (tree[segment] ||= {}), tree);
    }

    const handleTreeItem = (
      key: string,
      value: NestedRecord,
      mergedParents: string[],
      parents: string[],
      collection: vscode.TestItemCollection,
    ) => {
      const uri = vscode.Uri.file(path.join(this.root.fsPath, ...parents, key));
      const children = Object.entries(value);

      if (children.length === 1) {
        // if folder's only child is folder, merge them into one node
        const onlyChild = children[0];
        const [childKey, childValue] = onlyChild;
        const childIsFolder = Object.entries(childValue).length !== 0;
        if (childIsFolder) {
          handleTreeItem(
            childKey,
            childValue,
            [...mergedParents, key],
            [...parents, key],
            collection,
          );
          return;
        }
      }
      const item = this.testController.createTestItem(
        uri.toString(),
        [...mergedParents, key].join(path.sep),
        uri,
      );
      collection.add(item);

      const file = this.testFiles.get(uri.toString());
      if (file) {
        file.setTestItem(item);
        testData.set(item, file);
      } else {
        testData.set(item, new TestFolder(this.api, uri));
      }

      for (const [childKey, childValue] of children) {
        handleTreeItem(
          childKey,
          childValue,
          [],
          [...parents, key],
          item.children,
        );
      }
    };

    this.collection.replace([]);
    for (const [childKey, childValue] of Object.entries(tree)) {
      handleTreeItem(childKey, childValue, [], [], this.collection);
    }
    // testFiles has settled for this project; let the extension refresh any
    // derived state (e.g. the `rstack.rstest.testFiles` context key).
    this.onDidChangeTestFiles?.();
  }
}
