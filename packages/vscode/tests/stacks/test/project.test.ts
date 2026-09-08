import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, rs } from '@rstest/core';
import { ReportedRstestResolutionError } from '../../../src/stacks/test/coreResolution';
import { logger } from '../../../src/stacks/test/logger';
import { status } from '../../../src/stacks/test/status';
import type { NormalizedConfigResult } from '../../../src/stacks/test/types';
import { createStatusRecorder } from './statusRecorder';

// The worker-cwd decoupling adaptation pinned at its only site: upstream derived the
// worker spawn cwd inside `Project` as `dirname(configFileUri)`, so a `Project`
// pointing at rstack's shim would have cwd'd into `node_modules/rstack/dist/`.
// The values `RstestApi` is constructed with are therefore what this test
// asserts: the spawn cwd, the independently selected `@rstest/core` resolution
// root and the config file Rstest is asked to load.

const apiCalls: {
  cwd: string;
  configFilePath: string;
  rstestResolutionDir: string;
}[] = [];
let normalizedConfigFailure: unknown;
let normalizedConfigResult: NormalizedConfigResult | undefined;
let normalizedConfigCalls = 0;
let pendingConfig: Promise<NormalizedConfigResult> | undefined;
let runtimeCollection = false;
let listedFiles: string[] = [];
const renderedFiles = new Set<string>();
const fileWatchers: {
  root: string;
  active: boolean;
  create?: (uri: any) => void;
}[] = [];

rs.mock('../../../src/stacks/test/master', () => {
  class RstestApi {
    constructor(
      _workspace: unknown,
      cwd: string,
      configFilePath: string,
      _project: unknown,
      rstestResolutionDir: string,
    ) {
      apiCalls.push({ cwd, configFilePath, rstestResolutionDir });
    }
    // Never settles: the constructor's config-resolution continuation would
    // otherwise start watchers this test has no filesystem for.
    getNormalizedConfig() {
      normalizedConfigCalls += 1;
      if (pendingConfig) return pendingConfig;
      if (normalizedConfigFailure) {
        return Promise.reject(normalizedConfigFailure);
      }
      if (normalizedConfigResult) {
        return Promise.resolve(normalizedConfigResult);
      }
      return new Promise<never>(() => {});
    }
    async listTests(include?: string[]) {
      return (include ?? listedFiles).map((testPath) => ({
        testPath,
        tests: [],
      }));
    }
    dispose() {}
  }
  return { RstestApi, runningWorkers: new Set() };
});

// One log-channel double for both the vscode mock and `logger.bind`, so the
// assertions below observe every stack log line.
const loggedErrors: string[] = [];
const loggedWarnings: string[] = [];
const channel = {
  debug: () => {},
  info: () => {},
  warn: (message: string) => loggedWarnings.push(message),
  error: (message: string) => loggedErrors.push(message),
  show: () => {},
  dispose: () => {},
};

rs.mock('vscode', () => {
  const vscode = {
    Uri: {
      parse: (value: string) => uri(value.slice('file://'.length)),
      file: (fsPath: string) => ({
        scheme: 'file',
        fsPath,
        path: fsPath,
        toString: () => `file://${fsPath}`,
      }),
    },
    CancellationTokenSource: class {
      listeners: (() => void)[] = [];
      token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => {
          this.listeners.push(listener);
          return { dispose() {} };
        },
      };
      cancel() {
        this.token.isCancellationRequested = true;
        this.listeners.forEach((listener) => listener());
      }
      dispose() {}
    },
    RelativePattern: class {
      constructor(
        public base: unknown,
        public pattern: string,
      ) {}
    },
    window: {
      createOutputChannel: () => channel,
    },
    workspace: {
      fs: {},
      getConfiguration: () => ({
        get: (key: string) =>
          runtimeCollection && key === 'testCaseCollectMethod'
            ? 'runtime'
            : undefined,
      }),
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
      createFileSystemWatcher: (pattern: { base: { fsPath: string } }) => {
        const watcher: (typeof fileWatchers)[number] = {
          root: pattern.base.fsPath,
          active: true,
        };
        fileWatchers.push(watcher);
        return {
          onDidCreate: (listener: (uri: any) => void) => {
            watcher.create = listener;
            return { dispose() {} };
          },
          onDidChange: () => ({ dispose() {} }),
          onDidDelete: () => ({ dispose() {} }),
          dispose: () => {
            watcher.active = false;
          },
        };
      },
    },
  };
  return { ...vscode, default: vscode };
});

const uri = (fsPath: string) =>
  ({
    scheme: 'file',
    fsPath,
    path: fsPath,
    toString: () => `file://${fsPath}`,
  }) as any;

const workspaceFolder = {
  uri: uri('/repo'),
  name: 'repo',
  index: 0,
} as any;

const controller = {
  createTestItem: (id: string, label: string) => ({
    id,
    label,
    children: { replace: () => {}, add: () => {}, forEach: () => {} },
  }),
} as any;

const collection = {
  replace: () => {
    renderedFiles.clear();
  },
  add: (item: { id: string }) => {
    renderedFiles.add(item.id);
  },
  forEach: () => {},
} as any;

beforeEach(() => {
  normalizedConfigFailure = undefined;
  normalizedConfigResult = undefined;
  normalizedConfigCalls = 0;
  pendingConfig = undefined;
  runtimeCollection = false;
  listedFiles = [];
  renderedFiles.clear();
  fileWatchers.length = 0;
  loggedErrors.length = 0;
  loggedWarnings.length = 0;
  logger.bind(channel as never);
});

afterEach(() => {
  logger.unbind();
});

const createProject = async (source: any) => {
  apiCalls.length = 0;
  const { Project } = await import('../../../src/stacks/test/project');
  const project = new Project(workspaceFolder, source, controller, collection);
  return { project, api: apiCalls[0]! };
};

describe('Project config/cwd/package-resolution decoupling', () => {
  it('reports a late resolution failure to the shell and clears it after recovery', async () => {
    const gate = Promise.withResolvers<NormalizedConfigResult>();
    pendingConfig = gate.promise;
    const { reporter, reported } = createStatusRecorder();
    status.bind(reporter);
    const { project } = await createProject({
      sourceUri: uri('/repo/rstest.config.ts'),
    });
    try {
      expect(reported).toEqual([]);
      gate.reject(new ReportedRstestResolutionError());
      await rs.waitUntil(() => project.configLoadFailed);
      expect(reported.at(-1)).toEqual({
        kind: 'crashed',
        detail: 'Cannot load rstest.config.ts: Failed to resolve rstest path',
      });
      expect(loggedErrors).toEqual([]);
      pendingConfig = undefined;
      normalizedConfigResult = {
        ok: true,
        root: '/repo',
        include: [],
        exclude: [],
        childProjects: [],
      };
      await project.retryFailedConfig();
      expect(reported.at(-1)?.kind).toBe('running');
      expect(project.hasFailedState).toBe(false);
    } finally {
      project.dispose();
      status.unbind();
    }
  });

  it('replaces stale test files and watches the recovered root and globs only when changed', async () => {
    const oldRoot = path.join('/repo', 'old');
    const newRoot = path.join('/repo', 'new');
    const oldFile = path.join(oldRoot, 'old.test.ts');
    const currentFile = path.join(newRoot, 'current.spec.ts');
    const addedFile = path.join(newRoot, 'added.spec.ts');
    runtimeCollection = true;
    listedFiles = [oldFile];
    normalizedConfigResult = {
      ok: true,
      root: oldRoot,
      include: ['**/*.test.ts'],
      exclude: [],
      childProjects: [],
    };
    const { reporter } = createStatusRecorder();
    status.bind(reporter);
    const { project } = await createProject({
      sourceUri: uri('/repo/rstest.config.ts'),
    });
    const files = () => [...renderedFiles].sort();
    const createFile = (file: string) => {
      for (const watcher of fileWatchers) {
        if (watcher.active && file.startsWith(`${watcher.root}${path.sep}`))
          watcher.create?.(uri(file));
      }
    };
    try {
      await rs.waitUntil(() => files().includes(uri(oldFile).toString()));
      normalizedConfigFailure = new SyntaxError('half-written dependency');
      status.crashed('worker stopped', project.sourceUri.toString());
      await project.retryFailedConfig();
      normalizedConfigFailure = undefined;
      listedFiles = [currentFile];
      normalizedConfigResult = {
        ok: true,
        root: newRoot,
        include: ['**/*.spec.ts'],
        exclude: ['**/ignored.spec.ts'],
        childProjects: [],
      };
      await project.retryFailedConfig();
      await rs.waitUntil(() => files().includes(uri(currentFile).toString()));
      expect(files()).toEqual([uri(currentFile).toString()]);
      createFile(path.join(oldRoot, 'stale.test.ts'));
      createFile(path.join(newRoot, 'ignored.spec.ts'));
      createFile(path.join(newRoot, 'wrong.test.ts'));
      createFile(addedFile);
      await rs.waitUntil(() => files().includes(uri(addedFile).toString()));
      expect(files()).toEqual([
        uri(addedFile).toString(),
        uri(currentFile).toString(),
      ]);

      // Unchanged normalization must preserve the collected items rather than
      // re-listing and removing the file delivered through the watcher.
      normalizedConfigResult = {
        ...normalizedConfigResult,
        include: [...normalizedConfigResult.include],
        exclude: [...normalizedConfigResult.exclude],
      };
      await project.retryFailedConfig();
      expect(files()).toEqual([
        uri(addedFile).toString(),
        uri(currentFile).toString(),
      ]);
    } finally {
      project.dispose();
      status.unbind();
    }
  });

  it('re-resolves a core lost after successful config loading on a dependency pass', async () => {
    const config = uri('/repo/pkg/rstest.config.ts');
    const { reporter, reported } = createStatusRecorder();
    status.bind(reporter);
    const loaded: NormalizedConfigResult = {
      ok: true,
      root: '/repo/pkg',
      include: ['**/*.test.ts'],
      exclude: [],
      childProjects: [],
    };
    normalizedConfigResult = loaded;
    const { project } = await createProject({ sourceUri: config });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(project.configLoadFailed).toBe(false);

      // listTests -> createChildProcess -> resolveRstestPath reports this core
      // source, without going through Project.loadConfig's failure handler.
      project.api.listTests = rs.fn(async () => {
        status.notInstalled('@rstest/core is not installed', config.toString());
        throw new ReportedRstestResolutionError();
      });
      await expect(project.api.listTests()).rejects.toThrow(
        'Failed to resolve rstest path',
      );
      expect(project.configLoadFailed).toBe(false);
      expect(project.hasFailedState).toBe(true);

      // A new config request resolves the core before its worker RPC. Model
      // successful resolution's versionOk, which clears the core-source latch.
      const reResolve = rs
        .spyOn(project.api, 'getNormalizedConfig')
        .mockImplementation(async () => {
          status.versionOk(config.toString());
          return loaded;
        });
      const { WorkspaceManager } =
        await import('../../../src/stacks/test/project');
      WorkspaceManager.prototype.retryFailedProjects.call({
        projects: new Map([['config', project]]),
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reResolve).toHaveBeenCalledTimes(1);
      expect(project.hasFailedState).toBe(false);
      expect(reported.at(-1)).toEqual({ kind: 'running', detail: undefined });
      expect(loggedErrors).toEqual([]);
    } finally {
      project.dispose();
      status.unbind();
    }
  });

  it('retries a worker crash after successful config loading only until it recovers', async () => {
    const config = uri('/repo/pkg/rstest.config.ts');
    const { reporter, reported } = createStatusRecorder();
    status.bind(reporter);
    const loaded: NormalizedConfigResult = {
      ok: true,
      root: '/repo/pkg',
      include: ['**/*.test.ts'],
      exclude: [],
      childProjects: [],
    };
    normalizedConfigResult = loaded;
    const { project } = await createProject({ sourceUri: config });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(project.configLoadFailed).toBe(false);

      // createChildProcess reports unexpected worker errors and exits against
      // the project source, independently of the successful config load.
      status.crashed('worker process exited unexpectedly', config.toString());
      expect(project.configLoadFailed).toBe(false);
      expect(project.hasFailedState).toBe(true);

      // A config retry creates a fresh worker. Model its spawn notification,
      // which retires the crash recorded for this project source.
      const retry = rs
        .spyOn(project.api, 'getNormalizedConfig')
        .mockImplementation(async () => {
          status.workerSpawned(config.toString());
          return loaded;
        });
      const { WorkspaceManager } =
        await import('../../../src/stacks/test/project');
      const manager = {
        projects: new Map([['config', project]]),
      } as never;

      WorkspaceManager.prototype.retryFailedProjects.call(manager);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(retry).toHaveBeenCalledTimes(1);
      expect(project.hasFailedState).toBe(false);
      expect(reported.at(-1)).toEqual({ kind: 'running', detail: undefined });

      WorkspaceManager.prototype.retryFailedProjects.call(manager);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(retry).toHaveBeenCalledTimes(1);
    } finally {
      project.dispose();
      status.unbind();
    }
  });

  it('keeps the upstream derivation for a native rstest config', async () => {
    const configFile = uri(path.join('/repo', 'pkg', 'rstest.config.ts'));

    const { project, api } = await createProject({ sourceUri: configFile });

    // Byte-identical to upstream: cwd is the config file's directory.
    expect(api.cwd).toBe(path.join('/repo', 'pkg'));
    expect(api.rstestResolutionDir).toBe(path.join('/repo', 'pkg'));
    expect(api.configFilePath).toBe(configFile.fsPath);
    expect(project.configFilePath).toBe(configFile.fsPath);
    expect(project.sourceUri.toString()).toBe(configFile.toString());
    expect(project.isBridge).toBe(false);
    expect(project.root.fsPath).toBe(path.join('/repo', 'pkg'));
  });

  it('spawns a bridged project in the rstack config directory, not in the shim directory', async () => {
    const rstackConfig = uri(path.join('/repo', 'pkg', 'rstack.config.ts'));
    const shim = uri(
      path.join(
        '/repo',
        'pkg',
        'node_modules',
        'rstack',
        'dist',
        'rstestConfig.js',
      ),
    );
    const rstackDir = path.dirname(path.dirname(shim.fsPath));

    const { project, api } = await createProject({
      sourceUri: rstackConfig,
      configFileUri: shim,
      cwd: path.join('/repo', 'pkg'),
      rstestResolutionDir: rstackDir,
      isBridge: true,
    });

    // The whole point: `dirname(configFile)` would be
    // `<pkg>/node_modules/rstack/dist`, where the shim's single-directory,
    // no-parent-walk `loadRstackConfig()` probe finds nothing.
    expect(api.cwd).toBe(path.join('/repo', 'pkg'));
    expect(api.cwd).not.toBe(path.dirname(shim.fsPath));
    expect(api.rstestResolutionDir).toBe(rstackDir);
    // Rstest is still handed the shim as an ordinary JS config file.
    expect(api.configFilePath).toBe(shim.fsPath);
    expect(project.configFilePath).toBe(shim.fsPath);
    // Identity/labelling stays on the user-owned config file, so two bridged
    // projects in different directories do not collide on the shared shim path.
    expect(project.sourceUri.toString()).toBe(rstackConfig.toString());
    expect(project.isBridge).toBe(true);
    expect(project.root.fsPath).toBe(path.join('/repo', 'pkg'));
  });

  it('does not re-log a package-resolution failure that was already reported', async () => {
    normalizedConfigFailure = new ReportedRstestResolutionError();

    const { project } = await createProject({
      sourceUri: uri(path.join('/repo', 'pkg', 'rstest.config.ts')),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(project.configLoadFailed).toBe(true);
    expect(loggedErrors).toEqual([]);
  });

  it('reports a config whose dependency is not installed as one warning line', async () => {
    // A scaffolded template beside its generator: its own dependencies are
    // never installed, but the walk-up finds the generator's `rstack`, so the
    // shim loads and the config's own import is what fails.
    const rstackConfig = uri(
      path.join('/repo', 'templates', 'app', 'rstack.config.ts'),
    );
    // The worker's verdict, as data: it classified the failure where the
    // error's `code` still existed.
    normalizedConfigResult = {
      ok: false,
      message: `Cannot find package '@rsbuild/plugin-react' imported from ${rstackConfig.fsPath}`,
    };
    const { reporter, reported } = createStatusRecorder();
    status.bind(reporter);

    const { project } = await createProject({
      sourceUri: rstackConfig,
      configFileUri: uri('/repo/node_modules/rstack/dist/rstestConfig.js'),
      cwd: path.dirname(rstackConfig.fsPath),
      rstestResolutionDir: '/repo/node_modules/rstack',
      isBridge: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(project.configLoadFailed).toBe(true);
    expect(loggedErrors).toEqual([]);
    expect(loggedWarnings).toHaveLength(1);
    expect(loggedWarnings[0]).toContain(rstackConfig.fsPath);
    expect(loggedWarnings[0]).toContain(
      "Cannot find package '@rsbuild/plugin-react'",
    );
    expect(loggedWarnings[0]).toContain('Install the project dependencies');
    // The status bar side: `disabled` naming the config (workspace-relative)
    // and the way out — the same shape fmt and lint report.
    expect(reported).toEqual([
      {
        kind: 'disabled',
        reason:
          'templates/app/rstack.config.ts imports a package that is not installed — install the project dependencies, then run "Rstack: Restart Rstest" if this status stays',
      },
    ]);

    // Disposal forgets the latch, so the detection-driven retry starts clean.
    project.dispose();
    expect(reported.at(-1)).toEqual({ kind: 'running', detail: undefined });
    status.unbind();
  });

  it('retries a missing config dependency in place with one flight and one warning', async () => {
    const rstackConfig = uri('/repo/templates/app/rstack.config.ts');
    normalizedConfigResult = {
      ok: false,
      message: "Cannot find package '@rsbuild/plugin-react'",
    };
    const { reporter, reported } = createStatusRecorder();
    status.bind(reporter);
    const { project } = await createProject({ sourceUri: rstackConfig });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstRetry = project.retryFailedConfig();
    const sameRetry = project.retryFailedConfig();
    expect(firstRetry).toBe(sameRetry);
    await firstRetry;
    expect(normalizedConfigCalls).toBe(2);
    expect(loggedWarnings).toHaveLength(1);
    expect(project.configLoadFailed).toBe(true);

    normalizedConfigResult = {
      ok: true,
      root: '/repo/templates/app',
      include: ['**/*.test.ts'],
      exclude: [],
      childProjects: [],
    };
    await project.retryFailedConfig();
    expect(normalizedConfigCalls).toBe(3);
    expect(project.configLoadFailed).toBe(false);
    expect(reported.at(-1)).toEqual({ kind: 'running', detail: undefined });

    project.dispose();
    status.unbind();
  });

  it('keeps retrying a real config error on dependency passes and deduplicates it', async () => {
    const config = uri('/repo/templates/app/rstest.config.ts');
    normalizedConfigResult = {
      ok: false,
      message: "Cannot find package '@rstest/plugin-missing'",
    };
    const { reporter, reported } = createStatusRecorder();
    status.bind(reporter);
    const { project } = await createProject({ sourceUri: config });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(status.hasFailed()).toBe(true);
    normalizedConfigResult = undefined;
    normalizedConfigFailure = new SyntaxError('Unexpected token export');
    await project.retryFailedConfig();

    expect(project.configLoadFailed).toBe(true);
    expect(status.hasFailed()).toBe(true);
    expect(loggedWarnings).toHaveLength(1);
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]).toContain('Failed to initialize project config');
    expect(reported.at(-1)).toEqual({
      kind: 'crashed',
      detail:
        'Cannot load templates/app/rstest.config.ts: Unexpected token export',
    });

    const { WorkspaceManager } =
      await import('../../../src/stacks/test/project');
    WorkspaceManager.prototype.retryFailedProjects.call({
      projects: new Map([['config', project]]),
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(normalizedConfigCalls).toBe(3);
    expect(loggedErrors).toHaveLength(1);

    normalizedConfigFailure = new SyntaxError('Unexpected token import');
    WorkspaceManager.prototype.retryFailedProjects.call({
      projects: new Map([['config', project]]),
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loggedErrors).toHaveLength(2);

    normalizedConfigFailure = undefined;
    normalizedConfigResult = {
      ok: true,
      root: '/repo/templates/app',
      include: ['**/*.test.ts'],
      exclude: [],
      childProjects: [],
    };
    await project.retryFailedConfig();
    expect(reported.at(-1)).toEqual({ kind: 'running', detail: undefined });

    normalizedConfigResult = undefined;
    normalizedConfigFailure = new SyntaxError('Unexpected token export');
    status.crashed('retry this recovered project', config.toString());
    await project.retryFailedConfig();
    expect(loggedErrors).toHaveLength(3);

    project.dispose();
    status.unbind();
  });
});
