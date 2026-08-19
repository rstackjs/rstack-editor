import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, rs } from '@rstest/core';
import { ReportedRstestResolutionError } from '../../../src/stacks/test/coreResolution';
import { logger } from '../../../src/stacks/test/logger';

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
      if (normalizedConfigFailure) {
        return Promise.reject(normalizedConfigFailure);
      }
      return new Promise<never>(() => {});
    }
    dispose() {}
  }
  return { RstestApi, runningWorkers: new Set() };
});

// One log-channel double for both the vscode mock and `logger.bind`, so the
// assertions below observe every stack log line.
const loggedErrors: string[] = [];
const channel = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (message: string) => loggedErrors.push(message),
  show: () => {},
  dispose: () => {},
};

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
      createOutputChannel: () => channel,
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

beforeEach(() => {
  normalizedConfigFailure = undefined;
  loggedErrors.length = 0;
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
});
