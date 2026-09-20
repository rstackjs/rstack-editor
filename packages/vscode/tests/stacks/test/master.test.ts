import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, rs } from '@rstest/core';
import { logger } from '../../../src/stacks/test/logger';
import {
  RstestApi,
  runningWorkers,
  WATCHER_CLOSE_TIMEOUT_MS,
} from '../../../src/stacks/test/master';
import { nodeRequire } from '../../../src/stacks/test/nodeRequire';
import {
  type NodeProbe,
  configuredNodeBelowFloor,
  resetUserNodeCaches,
} from '../../../src/shared/nodeResolution';
import { status } from '../../../src/stacks/test/status';
import type { TestRunReporter } from '../../../src/stacks/test/testRunReporter';
import type { WorkerInitOptions } from '../../../src/stacks/test/types';
import { Worker } from '../../../src/stacks/test/worker';
import type { StackState, StatusReporter } from '../../../src/types';
import { createStatusRecorder } from './statusRecorder';

rs.mock('node:child_process', () => {
  const original = createRequire(__filename)(
    'node:child_process',
  ) as typeof import('node:child_process');
  return { ...original, spawn: rs.fn(original.spawn) };
});

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
const loggedWarnings: string[] = [];
const createdTerminals: string[] = [];
const settings: Record<string, unknown> = {};
let startDebugging = async (): Promise<boolean> => true;

const channel = {
  debug: () => {},
  info: () => {},
  warn: (message: string) => loggedWarnings.push(message),
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
    debug: { startDebugging: () => startDebugging() },
    env: { shell: '/bin/sh' },
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

// The opposite fixture: a cwd where `@rstest/core` resolves, for suites whose
// case under test sits past the resolution step.
const packageDir = path.resolve(__dirname, '../../..');

// Seeding the memo is how the probe is injected: `resolveWorkerNodeCommand`
// takes no probe option (it is called from deep inside a spawn path), and the
// memo is keyed by executable path, so a seeded entry is the answer it gets.
const seedNodeProbe = (executable: string, probe: NodeProbe) =>
  configuredNodeBelowFloor(executable, {
    probe: () => Promise.resolve(probe),
  });

// Settings are a module-level bag every suite writes into; clearing them per
// test keeps one suite's configuration from leaking into the next.
afterEach(() => {
  for (const key of Object.keys(settings)) delete settings[key];
});

const createApi = (cwd = noCoreDir, rstestResolutionDir = cwd) => {
  const workspace = { uri: { fsPath: cwd } };
  // `sourceUri` backs the per-project status latch key, which the version
  // check on the spawn path reads before anything can fail.
  const project = { sourceUri: { toString: () => `test://${cwd}` } };
  return new RstestApi(
    workspace as any,
    cwd,
    `${cwd}/rstest.config.ts`,
    project as any,
    rstestResolutionDir,
  );
};

const writeCoreInstall = (root: string, version = '0.12.0') => {
  const packageDir = path.join(root, 'node_modules', '@rstest', 'core');
  const entry = path.join(packageDir, 'index.js');
  const bin = path.join(packageDir, 'bin', 'rstest.js');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@rstest/core',
      version,
      exports: {
        '.': './index.js',
        './api': './api.js',
        './package.json': './package.json',
      },
      bin: { rstest: 'bin/rstest.js' },
    }),
  );
  fs.writeFileSync(entry, 'module.exports = {};\n');
  fs.writeFileSync(path.join(packageDir, 'api.js'), 'module.exports = {};\n');
  fs.writeFileSync(bin, '#!/usr/bin/env node\n');
  return { packageDir, entry, bin };
};

const resolveRstestPaths = (api: RstestApi) => ({
  paths: (api as any).resolveRstestPaths() as {
    apiPath: string;
    rstestPath: string;
  },
  bin: (api as any).resolveRstestBin() as string,
});

describe('RstestApi package-resolution anchor', () => {
  let root: string;
  let cwd: string;
  /** pnpm's virtual-store entry: `rstack` and its `@rstest/core` are siblings here. */
  let storeEntry: string;
  let rstackDir: string;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'rstest-resolution-')),
    );
    cwd = path.join(root, 'app');
    storeEntry = path.join(cwd, 'node_modules', '.pnpm', 'rstack@0.6.1');
    rstackDir = path.join(storeEntry, 'node_modules', 'rstack');
    fs.mkdirSync(rstackDir, { recursive: true });
    loggedErrors.length = 0;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps native projects anchored at their cwd', () => {
    const native = writeCoreInstall(cwd);
    writeCoreInstall(storeEntry);

    expect(resolveRstestPaths(createApi(cwd))).toEqual({
      paths: {
        apiPath: path.join(native.packageDir, 'api.js'),
        rstestPath: native.entry,
      },
      bin: native.bin,
    });
  });

  it('anchors bridged projects at the resolved rstack directory', () => {
    writeCoreInstall(cwd);
    const bridged = writeCoreInstall(storeEntry);

    expect(resolveRstestPaths(createApi(cwd, rstackDir))).toEqual({
      paths: {
        apiPath: path.join(bridged.packageDir, 'api.js'),
        rstestPath: bridged.entry,
      },
      bin: bridged.bin,
    });
  });

  it('lets rstestPackagePath override the bridge anchor', () => {
    writeCoreInstall(storeEntry);
    const configured = writeCoreInstall(path.join(root, 'configured'));
    settings.rstestPackagePath = path.join(
      configured.packageDir,
      'package.json',
    );

    expect(resolveRstestPaths(createApi(cwd, rstackDir))).toEqual({
      paths: {
        apiPath: path.join(configured.packageDir, 'api.js'),
        rstestPath: configured.entry,
      },
      bin: configured.bin,
    });
  });

  it('deduplicates each unsupported-version message until a supported version resolves', () => {
    writeCoreInstall(cwd, '0.5.0');
    const api = createApi(cwd);

    resolveRstestPaths(api);
    resolveRstestPaths(api);
    expect(loggedErrors).toEqual([
      `Unsupported @rstest/core version 0.5.0 resolved from ${cwd}`,
    ]);

    writeCoreInstall(cwd, '0.4.0');
    resolveRstestPaths(api);
    expect(loggedErrors.at(-1)).toBe(
      `Unsupported @rstest/core version 0.4.0 resolved from ${cwd}`,
    );

    writeCoreInstall(cwd);
    resolveRstestPaths(api);
    writeCoreInstall(cwd, '0.4.0');
    resolveRstestPaths(api);
    expect(loggedErrors).toHaveLength(3);

    resolveRstestPaths(createApi(cwd));
    expect(loggedErrors).toHaveLength(4);
  });

  it('rejects 0.11 before spawning and reports only a version mismatch', async () => {
    writeCoreInstall(cwd, '0.11.12');
    const recorder = createStatusRecorder();
    status.bind(recorder.reporter);
    shownMessages.length = 0;
    rs.mocked(spawn).mockClear();
    try {
      await expect(createApi(cwd).createChildProcess()).rejects.toMatchObject({
        name: 'ReportedRstestResolutionError',
      });
      expect(recorder.reported.at(-1)).toEqual({
        kind: 'version-mismatch',
        detail:
          '@rstest/core 0.11.12 is not supported, this extension requires >=0.12.0',
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(shownMessages).toEqual([]);
    } finally {
      status.unbind();
    }
  });
});

describe('RstestApi with a missing @rstest/core', () => {
  beforeEach(() => {
    shownMessages.length = 0;
    loggedErrors.length = 0;
    createdTerminals.length = 0;
    for (const key of Object.keys(settings)) delete settings[key];
  });

  it('should warn with the way out instead of notifying, while discovering projects', async () => {
    // The uniform not-installed policy: a `disabled` status with the way
    // out plus one warn line, never a crash and never a notification.
    loggedWarnings.length = 0;
    const { reporter, reported } = createStatusRecorder();
    status.bind(reporter);
    try {
      await expect(createApi().getNormalizedConfig()).rejects.toThrow(
        'Failed to resolve rstest path',
      );
    } finally {
      status.unbind();
    }
    expect(shownMessages).toEqual([]);
    expect(loggedErrors).toEqual([]);
    const logged = loggedWarnings.join('\n');
    expect(logged).toContain('@rstest/core is not installed');
    expect(logged).toContain(`searched from ${noCoreDir}`);
    expect(logged).toContain('rstestPackagePath');
    expect(logged).not.toContain('Require stack');
    expect(reported).toEqual([
      {
        kind: 'disabled',
        reason:
          '@rstest/core is not installed (node_modules missing) — install it, then run "Rstack: Restart Rstest" if this status stays',
      },
    ]);
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

  it('deduplicates a resolution error until resolution succeeds', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'rstest-vscode-')),
    );
    const installed = writeCoreInstall(root);
    const api = createApi(root);
    const resolve = () => (api as any).resolveRstestPaths();

    try {
      expect(resolve).toThrow();
      expect(resolve).toThrow();
      expect(shownMessages).toHaveLength(1);

      settings.rstestPackagePath = path.join(
        installed.packageDir,
        'package.json',
      );
      expect(resolve().rstestPath).toBe(installed.entry);

      settings.rstestPackagePath = configured;
      expect(resolve).toThrow();
      expect(shownMessages).toHaveLength(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deduplicates package metadata errors and toasts together until recovery', () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'rstest-log-')),
    );
    const installed = writeCoreInstall(root);
    const metadata = path.join(installed.packageDir, 'package.json');
    settings.rstestPackagePath = metadata;
    loggedErrors.length = 0;
    const original = nodeRequire.resolve;
    let broken = true;
    const spy = rs
      .spyOn(nodeRequire, 'resolve')
      .mockImplementation((specifier, options) => {
        if (broken && specifier === metadata)
          throw new Error('incomplete package metadata');
        return original(specifier, options);
      });
    const api = createApi(root);
    const resolve = () => (api as any).resolveRstestPaths();
    try {
      expect(resolve()).toBeUndefined();
      expect(resolve()).toBeUndefined();
      expect(shownMessages).toHaveLength(1);
      expect(loggedErrors).toHaveLength(1);
      broken = false;
      expect(resolve().rstestPath).toBe(installed.entry);
      broken = true;
      expect(resolve()).toBeUndefined();
      expect(shownMessages).toHaveLength(2);
      expect(loggedErrors).toHaveLength(2);
    } finally {
      spy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
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
  // `running` is what the holder repaints once its last latch is cleared, so
  // counting it observes an advisory being forgotten.
  let repaints = 0;

  // Adaptation #4 again: the stack reports through a singleton that no-ops
  // while unbound, which is what every other suite in this file sees.
  const reporter: StatusReporter = {
    stack: 'rstest',
    report: () => {},
    starting: () => {},
    running: () => {
      repaints += 1;
    },
    crashed: () => {},
    versionMismatch: (detail) => mismatches.push(detail),
  };

  const seedProbe = (probe: NodeProbe) => seedNodeProbe(configuredNode, probe);

  // Reaching the private method keeps these cases on the decision under test
  // instead of spawning a real worker process for each one.
  const resolveWorkerNodeCommand = (api: RstestApi) =>
    (api as any).resolveWorkerNodeCommand() as Promise<{
      nodeExecutable: string;
    }>;

  beforeEach(() => {
    mismatches.length = 0;
    repaints = 0;
    resetUserNodeCaches();
    status.bind(reporter);
    // The shared pin is read by its fully-qualified name through a section-less
    // `getConfiguration(undefined, folder)`, so the stub key carries the dots.
    settings['rstack.nodeExecutable'] = configuredNode;
  });

  afterEach(() => {
    status.unbind();
    resetUserNodeCaches();
  });

  // The verdict is reported off the spawn path, so a spawn resolves before the
  // report lands; awaiting the (memoized) verdict is what settles it.
  const settleVerdict = () => configuredNodeBelowFloor(configuredNode);

  it('should stay silent when the configured executable clears the floor', async () => {
    await seedProbe({ kind: 'ok', version: '24.3.0' });
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

  it('should scope the advisory to the project and forget it on dispose', async () => {
    await seedProbe({ kind: 'ok', version: '20.19.4' });
    const api = createApi();
    await resolveWorkerNodeCommand(api);
    await settleVerdict();
    expect(mismatches).toHaveLength(1);
    // The advisory is the project's fact: disposing the project clears its
    // latch, and the repaint to `running` is only reachable with no latch
    // left — a host-keyed advisory would have stayed stuck instead.
    api.dispose();
    expect(repaints).toBe(1);
  });

  // The two mid-flight races a settings-triggered restart makes reachable:
  // the verdict and the spawn each cross an await that can outlive `dispose()`.
  it('should drop a verdict that settles after dispose', async () => {
    await seedProbe({ kind: 'ok', version: '20.19.4' });
    const api = createApi();
    const pending = resolveWorkerNodeCommand(api);
    api.dispose();
    await pending;
    await settleVerdict();
    expect(mismatches).toEqual([]);
  });

  it('should refuse to spawn a worker after dispose', async () => {
    // The seed keeps the configured executable's probe off the real spawn
    // path, so the abort observed is the disposed check and not an earlier
    // resolution failure.
    await seedProbe({ kind: 'ok', version: '24.3.0' });
    const api = createApi(packageDir);
    const spawnMock = rs.mocked(spawn);
    spawnMock.mockClear();
    const spawning = api.createChildProcess();
    api.dispose();
    await expect(spawning).rejects.toThrow('disposed');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// Worker spawn failures: only the wrong-executable case is the user's to fix
// (and keeps its notification); the rest is absorbed — the rationale lives on
// the guard and the 'error' handler in `master.ts`.
describe('RstestApi worker spawn failures', () => {
  let api: RstestApi | undefined;
  let reported: StackState[];

  const crashes = () => reported.filter((state) => state.kind === 'crashed');

  const seedConfiguredNode = (executable: string) => {
    settings['rstack.nodeExecutable'] = executable;
    return seedNodeProbe(executable, { kind: 'ok', version: '24.3.0' });
  };

  beforeEach(() => {
    shownMessages.length = 0;
    loggedWarnings.length = 0;
    resetUserNodeCaches();
    const recorder = createStatusRecorder();
    reported = recorder.reported;
    status.bind(recorder.reporter);
  });

  afterEach(() => {
    api?.dispose();
    api = undefined;
    status.unbind();
    resetUserNodeCaches();
  });

  it('should log, not notify, when the spawn cwd no longer exists', async () => {
    await seedConfiguredNode(process.execPath);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rstest-gone-'));
    // Default resolution anchors at the (deleted) cwd on purpose: the guard
    // must fire before package resolution, which would otherwise misread the
    // deleted directory as "@rstest/core is not installed".
    api = createApi(cwd);
    fs.rmSync(cwd, { recursive: true, force: true });

    // The reported-error class keeps the quiet classification through the
    // callers — `logUnlessReported` must not re-log this as a failure.
    await expect(api.createChildProcess()).rejects.toMatchObject({
      name: 'ReportedRstestResolutionError',
      message: expect.stringContaining('no longer exists'),
    });

    expect(shownMessages).toEqual([]);
    expect(reported).toEqual([]);
    expect(loggedWarnings.join('\n')).toContain(cwd);
  });

  it('should keep notifying when the executable itself fails to spawn', async () => {
    await seedConfiguredNode(path.join(os.tmpdir(), 'no-such-node-xyz'));
    api = createApi(packageDir);

    await api.createChildProcess();
    await expect
      .poll(() => shownMessages[0] ?? '', { timeout: 5000 })
      .toContain('Rstest worker process failed');

    expect(crashes()).toHaveLength(1);
  });

  it('should absorb a post-spawn error instead of notifying', async () => {
    await seedConfiguredNode(process.execPath);
    // `--eval` wins over the worker script path, so the child is a plain
    // long-lived node — the point is the handler, not the worker protocol.
    settings.nodeExecArgs = [
      '--eval',
      'console.log("worker-up"); setInterval(() => {}, 1000)',
    ];
    api = createApi(packageDir);
    const spawnMock = rs.mocked(spawn);
    spawnMock.mockClear();
    try {
      const { worker } = await api.createChildProcess();
      const child = spawnMock.mock.results[0].value!;
      // Await the child's first stdout chunk, not the 'spawn' event: Node gives
      // no timing guarantee for 'spawn' relative to this continuation, while
      // stream data is buffered until a listener attaches — and 'spawn' (which
      // precedes all other events, setting the handler's latch) is guaranteed
      // delivered by the time data flows.
      await new Promise<void>((resolve) => {
        child.stdout?.on('data', () => resolve());
      });
      child.emit('error', new Error('write EPIPE'));
      expect(shownMessages).toEqual([]);
      expect(crashes()).toEqual([]);
      worker.$close();
    } finally {
      spawnMock.mockClear();
    }
  });
});

it('closes the config worker when config evaluation rejects', async () => {
  const api = createApi();
  const close = rs.fn();
  rs.spyOn(api, 'createChildProcess').mockResolvedValue({
    apiPath: '/project/rstest/api',
    rstestPath: '/project/rstest',
    worker: {
      getNormalizedConfig: async () => {
        throw new SyntaxError('Invalid config');
      },
      $close: close,
    },
  } as never);
  try {
    await expect(api.getNormalizedConfig()).rejects.toThrow('Invalid config');
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await api.dispose();
  }
});

describe('RstestApi graceful disposal', () => {
  afterEach(() => {
    rs.useRealTimers();
  });

  it('waits for watcher teardown before terminating the worker', async () => {
    const api = createApi();
    const order: string[] = [];
    const teardown = Promise.withResolvers<void>();
    const worker = {
      closeWatcher: rs.fn(async () => {
        await teardown.promise;
        order.push('teardown');
      }),
      $close: rs.fn(() => order.push('kill')),
    };
    (api as any).workers = new Set([worker]);

    const disposal = api.dispose();
    await Promise.resolve();
    expect(order).toEqual([]);

    teardown.resolve();
    await disposal;

    expect(worker.closeWatcher).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['teardown', 'kill']);
  });
});

class MockRstestProcess extends EventEmitter {
  static nextPid = 10_000;
  connected = true;
  respondToClose = true;
  killSignals: (NodeJS.Signals | number | undefined)[] = [];
  pid = MockRstestProcess.nextPid++;
  stderr = new EventEmitter();
  stdout = new EventEmitter();

  send(data: unknown): boolean {
    const request = data as { i?: string; m?: string; t?: string };
    if (
      this.respondToClose &&
      request.t === 'q' &&
      request.i &&
      request.m === 'closeWatcher'
    ) {
      this.emit('message', { t: 's', i: request.i, r: undefined });
    }
    return true;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    this.connected = false;
    queueMicrotask(() => this.emit('exit', 0, signal));
    return true;
  }
}

const spawnedProcesses: MockRstestProcess[] = [];
const realSpawn = createRequire(__filename)('node:child_process')
  .spawn as typeof spawn;

const mockWorker = (
  api: RstestApi,
  runTest: (data: WorkerInitOptions) => Promise<void> = async () => {},
) => {
  const worker = {
    $close: rs.fn(),
    closeWatcher: rs.fn(async () => {}),
    listTests: rs.fn(async () => []),
    runTest: rs.fn(runTest),
  };
  rs.spyOn(api, 'createChildProcess').mockResolvedValue({
    worker,
    apiPath: '/rstest/api.js',
    rstestPath: '/rstest/index.js',
  } as any);
  return worker;
};

const createInFlightOneShotWorker = (shouldReject = false) => {
  const order: string[] = [];
  const runStarted = Promise.withResolvers<void>();
  const runFinished = Promise.withResolvers<void>();
  const worker = new Worker();
  rs.spyOn(worker as any, 'init').mockResolvedValue({
    command: 'run',
    fileFilters: undefined,
    rstest: {
      run: async () => {
        runStarted.resolve();
        await runFinished.promise;
        order.push('teardown');
        if (shouldReject) throw new Error('test run failed');
        return { status: 'pass', unhandledErrors: [] };
      },
    },
  });
  return {
    worker,
    order,
    started: runStarted.promise,
    finish: runFinished.resolve,
  };
};

const createRunContext = () => {
  const output: string[] = [];
  let cancellationHandler: (() => void) | undefined;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (handler: () => void) => {
      cancellationHandler = handler;
      return { dispose: () => {} };
    },
  };
  return {
    output,
    run: { appendOutput: (message: string) => output.push(message) } as any,
    token: token as any,
    cancel() {
      token.isCancellationRequested = true;
      cancellationHandler?.();
    },
  };
};

describe('Rstest public API', () => {
  beforeEach(async () => {
    spawnedProcesses.length = 0;
    shownMessages.length = 0;
    loggedWarnings.length = 0;
    startDebugging = async () => true;
    resetUserNodeCaches();
    settings['rstack.nodeExecutable'] = process.execPath;
    await configuredNodeBelowFloor(process.execPath, {
      probe: async () => ({ kind: 'ok', version: '24.0.0' }),
    });
    rs.mocked(spawn).mockImplementation(() => {
      const child = new MockRstestProcess();
      spawnedProcesses.push(child);
      return child as never;
    });
  });

  afterEach(() => {
    status.unbind();
    resetUserNodeCaches();
    rs.useRealTimers();
    rs.restoreAllMocks();
    rs.mocked(spawn).mockImplementation(realSpawn);
    for (const key of Object.keys(settings)) delete settings[key];
  });

  describe('Rstest public test listing', () => {
    it('quotes file paths for targeted runtime discovery', async () => {
      const api = createApi();
      const worker = mockWorker(api);
      await api.listTests(['/x/file.test.ts']);
      expect(worker.listTests).toHaveBeenCalledWith(
        expect.objectContaining({ fileFilters: ['"/x/file.test.ts"'] }),
      );
    });

    it('returns file rows together with declarations for full discovery', async () => {
      const testPath = '/x/empty.test.ts';
      const declaration = {
        fullName: 'case',
        name: 'case',
        parentNames: [],
        project: 'rstest',
        testPath,
        type: 'case',
      } as const;
      const file = { project: 'rstest', testPath, type: 'file' } as const;
      const listTests = rs.fn(async ({ filesOnly }: { filesOnly?: boolean }) =>
        filesOnly ? [file] : [declaration],
      );
      const worker = new Worker();
      rs.spyOn(worker as any, 'init').mockResolvedValue({
        fileFilters: undefined,
        rstest: { listTests },
      });
      await expect(worker.listTests({} as WorkerInitOptions)).resolves.toEqual([
        file,
        declaration,
      ]);
      expect(listTests).toHaveBeenCalledWith({
        filesOnly: true,
        filters: undefined,
      });
    });

    it('collects declarations only for filtered refreshes', async () => {
      const testPath = '/x/example.test.ts';
      const declaration = {
        fullName: 'case',
        name: 'case',
        parentNames: [],
        project: 'rstest',
        testPath,
        type: 'case',
      } as const;
      const listTests = rs.fn(async () => [declaration]);
      const worker = new Worker();
      rs.spyOn(worker as any, 'init').mockResolvedValue({
        fileFilters: [`"${testPath}"`],
        rstest: { listTests },
      });
      await expect(worker.listTests({} as WorkerInitOptions)).resolves.toEqual([
        declaration,
      ]);
      expect(listTests).toHaveBeenCalledTimes(1);
      expect(listTests).toHaveBeenCalledWith({
        filters: [`"${testPath}"`],
        includeTaskLocation: true,
        includeSuites: true,
      });
    });

    it('closes the worker when test collection rejects', async () => {
      const api = createApi();
      const worker = {
        $close: rs.fn(() => runningWorkers.delete(worker as any)),
        listTests: rs.fn(async () => {
          throw new Error('Test collection failed.');
        }),
      };
      runningWorkers.add(worker as any);
      rs.spyOn(api, 'createChildProcess').mockResolvedValue({
        worker,
        apiPath: '/rstest/api.js',
        rstestPath: '/rstest/index.js',
      } as any);
      await expect(api.listTests()).rejects.toThrow('Test collection failed.');
      expect(worker.$close).toHaveBeenCalledTimes(1);
    });
  });

  describe('Rstest public run lifecycle', () => {
    it.each([
      { filter: '/x/tests', kind: 'folder' },
      { filter: '"/x/tests/file.test.ts"', kind: 'file' },
    ])('forwards the $kind path without a filter mode', async ({ filter }) => {
      const api = createApi();
      const engineRun = rs.fn(async () => ({
        status: 'pass',
        unhandledErrors: [],
      }));
      const coreWorker = new Worker();
      rs.spyOn(coreWorker as any, 'init').mockResolvedValue({
        command: 'run',
        fileFilters: [filter],
        rstest: { run: engineRun },
      });
      const worker = mockWorker(api, (data) => coreWorker.runTest(data));
      const { run, token } = createRunContext();
      await api.runTest({ fileFilter: filter, run, token });
      expect(worker.runTest).toHaveBeenCalledWith(
        expect.objectContaining({ fileFilters: [filter] }),
      );
      expect(engineRun).toHaveBeenCalledWith({ filters: [filter] });
    });

    it('finishes when a worker resolves without a reporter end event', async () => {
      const api = createApi();
      const worker = mockWorker(api);
      const { run, token } = createRunContext();
      await expect(api.runTest({ run, token })).resolves.toBeUndefined();
      expect(worker.$close).toHaveBeenCalledTimes(1);
    });

    it('surfaces every unhandled error from a one-shot run', async () => {
      const api = createApi();
      const coreWorker = new Worker();
      rs.spyOn(coreWorker as any, 'init').mockResolvedValue({
        command: 'run',
        fileFilters: undefined,
        rstest: {
          run: async () => ({
            status: 'error',
            unhandledErrors: [
              { message: 'Build failed' },
              { message: 'Invalid config' },
            ],
          }),
        },
      });
      const worker = mockWorker(api, (data) => coreWorker.runTest(data));
      const { output, run, token } = createRunContext();
      await api.runTest({ run, token });
      expect(worker.$close).toHaveBeenCalledTimes(1);
      expect(output.join('')).toContain('Build failed\r\n\r\nInvalid config');
      expect(shownMessages).toContain(
        'Rstest test run failed: Build failed\n\nInvalid config',
      );
    });

    it('does not surface ordinary test failures as a global run error', async () => {
      const api = createApi();
      const coreWorker = new Worker();
      rs.spyOn(coreWorker as any, 'init').mockResolvedValue({
        command: 'run',
        fileFilters: undefined,
        rstest: {
          run: async () => ({
            status: 'fail',
            summary: { tests: { failed: 1 }, files: { failed: 1 } },
            unhandledErrors: [],
          }),
        },
      });
      mockWorker(api, (data) => coreWorker.runTest(data));
      const { output, run, token } = createRunContext();
      await api.runTest({ run, token });
      expect(output).toEqual([]);
      expect(shownMessages).toEqual([]);
    });

    it('waits for an active one-shot run when cancellation closes the worker', async () => {
      const api = createApi();
      const {
        worker: coreWorker,
        order,
        started,
        finish,
      } = createInFlightOneShotWorker();
      const worker = mockWorker(api, (data) => coreWorker.runTest(data));
      worker.closeWatcher.mockImplementation(() => coreWorker.closeWatcher());
      worker.$close.mockImplementation(() => {
        if ((worker as any).$closed) return;
        (worker as any).$closed = true;
        order.push('kill');
      });
      const { run, token, cancel } = createRunContext();
      const running = api.runTest({ run, token });
      await started;
      cancel();
      await new Promise<void>((resolve) => setTimeout(resolve));
      expect(worker.$close).not.toHaveBeenCalled();
      finish();
      await running;
      await expect.poll(() => worker.$close.mock.calls.length).toBe(1);
      expect(order).toEqual(['teardown', 'kill']);
    });

    it('surfaces coverage failures without test-level failures', async () => {
      const api = createApi();
      const coreWorker = new Worker();
      rs.spyOn(coreWorker as any, 'init').mockResolvedValue({
        command: 'run',
        fileFilters: undefined,
        rstest: {
          run: async () => ({
            status: 'fail',
            summary: { tests: { failed: 0 }, files: { failed: 0 } },
            unhandledErrors: [],
          }),
        },
      });
      mockWorker(api, (data) => coreWorker.runTest(data));
      const { output, run, token } = createRunContext();
      await api.runTest({ run, token });
      expect(output.join('')).toContain(
        'Rstest run failed without test-level failures',
      );
      expect(shownMessages[0]).toContain(
        'coverage report errors or unmet coverage thresholds',
      );
    });

    it('finishes a rejected continuous run and surfaces its error', async () => {
      const api = createApi();
      const worker = mockWorker(api, async () => {
        throw new Error('Browser launch failed');
      });
      const { output, run, token } = createRunContext();
      await api.runTest({ run, token, continuous: true });
      expect(worker.$close).toHaveBeenCalledTimes(1);
      expect(output.join('')).toContain('Browser launch failed');
    });

    it('waits for continuous worker startup after the first reporter cycle', async () => {
      const api = createApi();
      const startup = Promise.withResolvers<void>();
      let reporter: TestRunReporter | undefined;
      const worker = {
        $close: rs.fn(),
        closeWatcher: rs.fn(async () => {}),
        runTest: rs.fn(() => startup.promise),
      };
      rs.spyOn(api, 'createChildProcess').mockImplementation(async (value) => {
        reporter = value;
        return {
          worker,
          apiPath: '/rstest/api.js',
          rstestPath: '/rstest/index.js',
        } as any;
      });
      const { run, token } = createRunContext();
      const order: string[] = [];
      run.appendOutput = () => order.push('output');
      run.end = () => order.push('end');
      const hostRun = api
        .runTest({ run, token, continuous: true })
        .finally(() => run.end());
      await Promise.resolve();
      await reporter!.onTestRunEnd();
      reporter!.onOutput('Waiting for file changes...');
      await Promise.resolve();
      expect(order).toEqual(['output']);
      startup.resolve();
      await hostRun;
      expect(order).toEqual(['output', 'end']);
    });

    it('waits for watcher startup before terminating a canceled continuous run', async () => {
      const api = createApi();
      const order: string[] = [];
      const watcherStartup = Promise.withResolvers<{
        close(): Promise<void>;
      }>();
      const watcherStarted = Promise.withResolvers<void>();
      const coreWorker = new Worker();
      rs.spyOn(coreWorker as any, 'init').mockResolvedValue({
        command: 'watch',
        fileFilters: undefined,
        rstest: {
          watch: () => {
            watcherStarted.resolve();
            return watcherStartup.promise;
          },
        },
      });
      const worker = mockWorker(api, (data) => coreWorker.runTest(data));
      worker.closeWatcher.mockImplementation(() => coreWorker.closeWatcher());
      worker.$close.mockImplementation(() => {
        if ((worker as any).$closed) return;
        (worker as any).$closed = true;
        order.push('kill');
      });
      const { run, token, cancel } = createRunContext();
      const running = api.runTest({ run, token, continuous: true });
      await watcherStarted.promise;
      cancel();
      expect(worker.$close).not.toHaveBeenCalled();
      watcherStartup.resolve({
        close: async () => {
          order.push('teardown');
        },
      });
      await running;
      await expect.poll(() => worker.$close.mock.calls.length).toBe(1);
      expect(order).toEqual(['teardown', 'kill']);
    });
  });

  describe('Rstest public disposal and debug startup', () => {
    let root: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstest-public-api-'));
      writeCoreInstall(root);
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('waits for an active one-shot run before disposing the worker', async () => {
      const api = createApi();
      const {
        worker: coreWorker,
        order,
        started,
        finish,
      } = createInFlightOneShotWorker(true);
      const operation = coreWorker.runTest({} as WorkerInitOptions);
      const result = operation.then(
        () => 'resolved',
        () => 'rejected',
      );
      await started;
      const worker = {
        closeWatcher: rs.fn(() => coreWorker.closeWatcher()),
        $close: rs.fn(() => order.push('kill')),
      };
      (api as any).workers = new Set([worker]);
      const disposal = api.dispose();
      await new Promise<void>((resolve) => setTimeout(resolve));
      expect(worker.$close).not.toHaveBeenCalled();
      finish();
      await expect(result).resolves.toBe('rejected');
      await disposal;
      expect(order).toEqual(['teardown', 'kill']);
    });

    it('uses SIGKILL when graceful watcher teardown times out', async () => {
      rs.useFakeTimers();
      loggedWarnings.length = 0;
      const api = createApi(root);
      await api.createChildProcess();
      spawnedProcesses[0].respondToClose = false;
      const disposal = api.dispose();
      await rs.advanceTimersByTimeAsync(WATCHER_CLOSE_TIMEOUT_MS);
      await disposal;
      expect(spawnedProcesses[0].killSignals).toEqual(['SIGKILL']);
      expect(loggedWarnings).toContain(
        'Timed out waiting for the continuous test watcher to close; terminating the worker. Watcher teardown was skipped.',
      );
    });

    it('closes a spawned worker when debugger attachment rejects', async () => {
      startDebugging = async () => {
        throw new Error('Debugger attachment failed.');
      };
      const api = createApi(root);
      await expect(api.createChildProcess(undefined, true)).rejects.toThrow(
        'Debugger attachment failed.',
      );
      expect(spawnedProcesses[0].killSignals).toEqual(['SIGTERM']);
      expect((api as any).workers.size).toBe(0);
      expect(runningWorkers.size).toBe(0);
    });

    it('closes a worker when disposal starts during debugger attachment', async () => {
      const attachment = Promise.withResolvers<boolean>();
      const started = Promise.withResolvers<void>();
      startDebugging = () => {
        started.resolve();
        return attachment.promise;
      };
      const api = createApi(root);
      const starting = api.createChildProcess(undefined, true);
      await started.promise;
      // dispose() sets this flag synchronously before closing its current worker
      // snapshot; isolate the post-attach guard from the close RPC exercised by
      // the disposal tests above.
      (api as any).disposed = true;
      attachment.resolve(true);
      await expect(starting).rejects.toThrow(
        'worker spawn aborted: this master was disposed while the debugger was attaching',
      );
      expect(spawnedProcesses[0].killSignals).toEqual(['SIGTERM']);
      expect(runningWorkers.size).toBe(0);
    });
  });
});
