import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, rs } from '@rstest/core';
import { logger } from '../../../src/stacks/test/logger';
import { RstestApi } from '../../../src/stacks/test/master';
import {
  type NodeProbe,
  configuredNodeBelowFloor,
  resetWorkerNodeCaches,
} from '../../../src/stacks/test/nodeResolution';
import { status } from '../../../src/stacks/test/status';
import type { StatusReporter } from '../../../src/types';

// The Rstest runner injects its own `@rstest/core` into every resolution path so
// that test files can import it, which makes "the project has no @rstest/core"
// impossible to stage in-process. `nodeRequire` is therefore wrapped: a lookup
// of `@rstest/core` that has no package directory above the search path fails
// the way Node would, and every other lookup — including the *installed but
// unusable* fixture below — goes to the real resolver untouched.
rs.mock('../../../src/stacks/test/nodeRequire', () => {
  const realRequire = createRequire(__filename);

  const hasInstalledCore = (from: string): boolean => {
    let dir = path.resolve(from);
    for (;;) {
      if (fs.existsSync(path.join(dir, 'node_modules', '@rstest', 'core'))) {
        return true;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  };

  const nodeRequire = ((id: string) => realRequire(id)) as NodeJS.Require;
  nodeRequire.resolve = ((
    specifier: string,
    options?: { paths?: string[] },
  ) => {
    const isCore =
      specifier === '@rstest/core' || specifier.startsWith('@rstest/core/');
    const from = options?.paths?.[0];
    if (isCore && from && !hasInstalledCore(from)) {
      // Same shape as Node's own error; `isModuleNotFoundError` is pinned
      // against a real one in `coreResolution.test.ts`.
      throw Object.assign(new Error(`Cannot find module '${specifier}'`), {
        code: 'MODULE_NOT_FOUND',
      });
    }
    return realRequire.resolve(specifier, options);
  }) as NodeJS.RequireResolve;

  return { nodeRequire };
});

// Everything the extension surfaces: notifications the user cannot miss, the
// output channel, and the terminal a "Run in Terminal" would open.
const shownMessages: string[] = [];
const loggedErrors: string[] = [];
const createdTerminals: string[] = [];
const settings: Record<string, unknown> = {};

const channel = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (message: string) => loggedErrors.push(message),
  show: () => {},
  dispose: () => {},
};

// Adaptation #4: the output channel belongs to the shell and is handed to the
// stack at `register()`. Upstream's `MasterLogger` created its own, so mocking
// `vscode.window.createOutputChannel` was enough; here the binding has to be
// made explicitly or every `logger.error` is a silent no-op.
logger.bind(channel as never);

rs.mock('vscode', () => {
  const vscode = {
    TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
    FileCoverage: class {},
    Position: class {},
    Range: class {},
    Uri: {
      file: (fsPath: string) => ({
        fsPath,
        toString: () => `file://${fsPath}`,
      }),
    },
    extensions: { getExtension: () => undefined },
    window: {
      createOutputChannel: () => channel,
      createTerminal: (options: { name: string }) => {
        createdTerminals.push(options.name);
        return { show: () => {}, sendText: () => {}, dispose: () => {} };
      },
      onDidCloseTerminal: () => ({ dispose: () => {} }),
      showErrorMessage: (message: string) => shownMessages.push(message),
      showWarningMessage: (message: string) => shownMessages.push(message),
      showInformationMessage: (message: string) => shownMessages.push(message),
    },
    workspace: {
      getConfiguration: () => ({
        get: (key: string) => settings[key],
      }),
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
    },
  };
  return { ...vscode, default: vscode };
});

// A directory outside the repository, so Node's upward resolution cannot reach
// the workspace `node_modules` and `@rstest/core` is genuinely missing.
const noCoreDir = os.tmpdir();

const createApi = (cwd = noCoreDir) => {
  const workspace = { uri: { fsPath: cwd } };
  return new RstestApi(
    workspace as any,
    cwd,
    `${cwd}/rstest.config.ts`,
    {} as any,
  );
};

describe('RstestApi with a missing @rstest/core', () => {
  beforeEach(() => {
    shownMessages.length = 0;
    loggedErrors.length = 0;
    createdTerminals.length = 0;
    for (const key of Object.keys(settings)) delete settings[key];
  });

  it('should log an actionable message instead of notifying, while discovering projects', async () => {
    await expect(createApi().getNormalizedConfig()).rejects.toThrow(
      'Failed to resolve rstest path',
    );
    expect(shownMessages).toEqual([]);
    const logged = loggedErrors.join('\n');
    expect(logged).toContain(`Cannot find "@rstest/core" from ${noCoreDir}`);
    expect(logged).toContain('Install the project dependencies');
    expect(logged).not.toContain('Require stack');
  });

  it('should stay silent while listing tests', async () => {
    await expect(createApi().listTests()).rejects.toThrow(
      'Failed to resolve rstest path',
    );
    expect(shownMessages).toEqual([]);
  });

  it('should stay silent while running tests', async () => {
    await expect(
      createApi().runTest({ run: {} as any, token: {} as any }),
    ).rejects.toThrow('Failed to resolve rstest path');
    expect(shownMessages).toEqual([]);
  });

  it('should stay silent, and open no terminal, for a terminal run', () => {
    createApi().runInTerminal({});
    expect(shownMessages).toEqual([]);
    expect(createdTerminals).toEqual([]);
  });
});

// Installed but unusable — an interrupted install, or a workspace link that
// has not been built. Advising an install would be wrong, and staying silent
// would hide a broken state the user has to repair.
describe('RstestApi with an unusable @rstest/core', () => {
  let root: string;

  beforeEach(() => {
    shownMessages.length = 0;
    loggedErrors.length = 0;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstest-vscode-'));
    const pkgDir = path.join(root, 'node_modules', '@rstest', 'core');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      '{"name":"@rstest/core","version":"9.9.9","main":"./gone.js"}',
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('should notify instead of reporting it as not installed', async () => {
    await expect(createApi(root).getNormalizedConfig()).rejects.toThrow();
    expect(shownMessages).toHaveLength(1);
    expect(shownMessages[0]).toContain('gone.js');
    expect(loggedErrors.join('\n')).not.toContain(
      'Install the project dependencies',
    );
  });
});

// A configured `rstestPackagePath` that does not resolve is not the
// "dependencies are not installed yet" state — the user picked that path and
// has to fix it, so silence would strand them.
describe('RstestApi with an unresolvable rstestPackagePath', () => {
  const configured = `${noCoreDir}/vendor/core/package.json`;

  beforeEach(() => {
    shownMessages.length = 0;
    settings.rstestPackagePath = configured;
  });

  it('should notify while discovering projects', async () => {
    await expect(createApi().getNormalizedConfig()).rejects.toThrow();
    expect(shownMessages).toHaveLength(1);
    expect(shownMessages[0]).toContain('rstack.rstest.rstestPackagePath');
    expect(shownMessages[0]).toContain(configured);
  });

  it('should notify for a terminal run', () => {
    createApi().runInTerminal({});
    expect(shownMessages).toHaveLength(1);
    expect(shownMessages[0]).toContain('rstack.rstest.rstestPackagePath');
    expect(createdTerminals).toEqual([]);
  });
});

// An explicit `nodeExecutable` is the escape hatch and is always honoured — but
// a setting pointed at a Node that has since fallen below the floor is the very
// failure the worker-runtime adaptation exists to catch, and the spawn succeeds,
// so nothing else would ever say so.
describe('RstestApi with a configured nodeExecutable', () => {
  const configuredNode = '/opt/node/bin/node';
  const mismatches: string[] = [];

  // Adaptation #4 again: the stack reports through a singleton that no-ops
  // while unbound, which is what every other suite in this file sees.
  const reporter: StatusReporter = {
    stack: 'rstest',
    report: () => {},
    starting: () => {},
    running: () => {},
    crashed: () => {},
    versionMismatch: (detail) => mismatches.push(detail),
  };

  // Seeding the memo is how the probe is injected: `resolveWorkerNodeCommand`
  // takes no probe option (it is called from deep inside a spawn path), and the
  // memo is keyed by executable path, so a seeded entry is the answer it gets.
  const seedProbe = (probe: NodeProbe) =>
    configuredNodeBelowFloor(configuredNode, {
      probe: () => Promise.resolve(probe),
    });

  // Reaching the private method keeps these cases on the decision under test
  // instead of spawning a real worker process for each one.
  const resolveWorkerNodeCommand = (api: RstestApi) =>
    (api as any).resolveWorkerNodeCommand() as Promise<{
      nodeExecutable: string;
    }>;

  beforeEach(() => {
    mismatches.length = 0;
    resetWorkerNodeCaches();
    status.bind(reporter);
    settings.nodeExecutable = configuredNode;
  });

  afterEach(() => {
    status.unbind();
    resetWorkerNodeCaches();
    delete settings.nodeExecutable;
  });

  // The verdict is reported off the spawn path, so a spawn resolves before the
  // report lands; awaiting the (memoized) verdict is what settles it.
  const settleVerdict = () => configuredNodeBelowFloor(configuredNode);

  it('should stay silent when the configured executable clears the floor', async () => {
    await seedProbe({ kind: 'ok', version: '24.0.0' });
    const { nodeExecutable } = await resolveWorkerNodeCommand(createApi());
    await settleVerdict();
    expect(nodeExecutable).toBe(configuredNode);
    expect(mismatches).toEqual([]);
  });

  // The wording itself is `nodeResolution.test.ts`'s to pin; what this level
  // owns is the wiring — a verdict reaches the status, and the executable is
  // handed back regardless.
  it('should report a below-floor executable and still run with it', async () => {
    await seedProbe({ kind: 'ok', version: '20.19.4' });
    const { nodeExecutable } = await resolveWorkerNodeCommand(createApi());
    await settleVerdict();
    // Never refused: the setting is the escape hatch.
    expect(nodeExecutable).toBe(configuredNode);
    expect(mismatches).toHaveLength(1);
  });
});
