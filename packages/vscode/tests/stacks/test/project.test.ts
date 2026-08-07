import path from 'node:path';
import { describe, expect, it, rs } from '@rstest/core';

// The worker-cwd decoupling adaptation pinned at its only site: upstream derived the
// worker spawn cwd inside `Project` as `dirname(configFileUri)`, so a `Project`
// pointing at rstack's shim would have cwd'd into `node_modules/rstack/dist/`.
// The three values `RstestApi` is constructed with are therefore what this test
// asserts — they are the spawn cwd, the `@rstest/core` resolution root and the
// config file Rstest is asked to load.

const apiCalls: { cwd: string; configFilePath: string }[] = [];

rs.mock('../../../src/stacks/test/master', () => {
  class RstestApi {
    constructor(
      _workspace: unknown,
      cwd: string,
      configFilePath: string,
      _project: unknown,
    ) {
      apiCalls.push({ cwd, configFilePath });
    }
    // Never settles: the constructor's config-resolution continuation would
    // otherwise start watchers this test has no filesystem for.
    getNormalizedConfig() {
      return new Promise<never>(() => {});
    }
    dispose() {}
  }
  return { RstestApi, runningWorkers: new Set() };
});

rs.mock('vscode', () => {
  const vscode = {
    Uri: {
      file: (fsPath: string) => ({
        scheme: 'file',
        fsPath,
        path: fsPath,
        toString: () => `file://${fsPath}`,
      }),
    },
    CancellationTokenSource: class {
      token = { isCancellationRequested: false };
      cancel() {
        this.token.isCancellationRequested = true;
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
      createOutputChannel: () => ({
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        show: () => {},
        dispose: () => {},
      }),
    },
    workspace: {
      fs: {},
      getConfiguration: () => ({ get: () => undefined }),
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
      createFileSystemWatcher: () => ({
        onDidCreate: () => ({ dispose: () => {} }),
        onDidChange: () => ({ dispose: () => {} }),
        onDidDelete: () => ({ dispose: () => {} }),
        dispose: () => {},
      }),
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
  replace: () => {},
  add: () => {},
  forEach: () => {},
} as any;

const createProject = async (source: any) => {
  apiCalls.length = 0;
  const { Project } = await import('../../../src/stacks/test/project');
  const project = new Project(workspaceFolder, source, controller, collection);
  return { project, api: apiCalls[0]! };
};

describe('Project config/cwd decoupling', () => {
  it('keeps the upstream derivation for a native rstest config', async () => {
    const configFile = uri(path.join('/repo', 'pkg', 'rstest.config.ts'));

    const { project, api } = await createProject({ sourceUri: configFile });

    // Byte-identical to upstream: cwd is the config file's directory.
    expect(api.cwd).toBe(path.join('/repo', 'pkg'));
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

    const { project, api } = await createProject({
      sourceUri: rstackConfig,
      configFileUri: shim,
      cwd: path.join('/repo', 'pkg'),
      isBridge: true,
    });

    // The whole point: `dirname(configFile)` would be
    // `<pkg>/node_modules/rstack/dist`, where the shim's single-directory,
    // no-parent-walk `loadRstackConfig()` probe finds nothing and
    // `@rstest/core` would resolve from rstack's own dependency tree.
    expect(api.cwd).toBe(path.join('/repo', 'pkg'));
    expect(api.cwd).not.toBe(path.dirname(shim.fsPath));
    // Rstest is still handed the shim as an ordinary JS config file.
    expect(api.configFilePath).toBe(shim.fsPath);
    expect(project.configFilePath).toBe(shim.fsPath);
    // Identity/labelling stays on the user-owned config file, so two bridged
    // projects in different directories do not collide on the shared shim path.
    expect(project.sourceUri.toString()).toBe(rstackConfig.toString());
    expect(project.isBridge).toBe(true);
    expect(project.root.fsPath).toBe(path.join('/repo', 'pkg'));
  });
});
