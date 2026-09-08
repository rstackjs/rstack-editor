import { expect, it, rs } from '@rstest/core';
import type {
  DetectionSnapshot,
  StackContext,
  StackState,
} from '../../../src/types';
import type { RslintOptions } from '../../../src/stacks/lint/Rslint';
import type { ResolvedCoreRuntime } from '../../../src/stacks/lint/CoreResolver';
import { registerEditorProxy } from '../../../src/stacks/lint/worker/index';

let refreshOutcome:
  'missing' | 'broken' | 'fixed' | 'changed' | 'changed-once' = 'missing';
let pendingRefresh: Promise<void> | undefined;
let refreshCalls = 0;
let reconciles = 0;

rs.mock('vscode', () => {
  const api = {
    RelativePattern: class {},
    workspace: {
      textDocuments: [],
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      onDidOpenTextDocument: () => ({ dispose() {} }),
      onDidCloseTextDocument: () => ({ dispose() {} }),
      createFileSystemWatcher: () => ({
        onDidCreate() {},
        onDidChange() {},
        onDidDelete() {},
      }),
    },
    env: {},
  };
  return { ...api, default: api };
});
let runtimeFactory: (resolved: ResolvedCoreRuntime) => Rslint;
rs.mock('../../../src/stacks/lint/RuntimeManager', () => ({
  RuntimeManager: class {
    constructor(
      _router: unknown,
      _resolver: unknown,
      create: typeof runtimeFactory,
    ) {
      runtimeFactory = create;
    }
    initialize() {}
    clearResolutionCache() {}
    async reconcileOpenDocuments() {
      reconciles++;
    }
  },
}));
rs.mock('../../../src/stacks/lint/CoreResolver', () => ({
  CoreResolver: class {},
}));
rs.mock('../../../src/stacks/lint/ruleDocumentationProviders', () => ({
  registerRuleDocumentationProviders: () => [],
}));
rs.mock('../../../src/shared/nodeExecutableSetting', () => ({
  getConfiguredNodeExecutable: () => undefined,
}));
rs.mock('../../../src/shared/nodeResolution', () => ({
  resolveUserNodeOnce: async () => ({ executable: 'node' }),
}));
rs.mock('vscode-languageclient/node', () => ({
  State: { Running: 2, Stopped: 1 },
  LanguageClient: class {
    state = 2;
    private notification: ((value: unknown) => void) | undefined;
    onNotification(_method: unknown, callback: (value: unknown) => void) {
      this.notification = callback;
    }
    onDidChangeState() {
      return { dispose() {} };
    }
    createDefaultErrorHandler() {
      return {};
    }
    async start() {}
    async sendRequest() {
      refreshCalls++;
      if (pendingRefresh) return pendingRefresh;
      if (refreshOutcome === 'changed' || refreshOutcome === 'changed-once') {
        if (refreshOutcome === 'changed-once') refreshOutcome = 'fixed';
        let request!: (method: string, params: unknown) => Promise<unknown>;
        // Use the real worker proxy so the test observes its notification
        // ordering, not a mock of the behavior being fixed.
        registerEditorProxy(
          {
            onRequest: (handler: typeof request) => {
              request = handler;
            },
            onNotification() {},
            sendNotification: (_method: string, params: unknown) =>
              this.notification?.(params),
          } as never,
          {
            sendRequest: async () => {
              throw new Error('config changed while loading');
            },
          } as never,
          {
            protocolVersion: 2,
            takeConfigStatus: () => ({ kind: 'ok' }),
            observeRefresh() {},
            requestStop() {},
          },
        );
        return request('rslint/configRefresh', { reason: 'initial' });
      }
      if (refreshOutcome !== 'missing') {
        this.notification?.(
          refreshOutcome === 'broken'
            ? { kind: 'error', message: 'Invalid config' }
            : { kind: 'ok' },
        );
        if (refreshOutcome === 'broken') throw new Error('Invalid config');
        return;
      }
      this.notification?.({
        kind: 'missing',
        failure: {
          configPath: '/project/rslint.config.mjs',
          cause: "Cannot find package 'missing'",
        },
      });
      throw new Error('configRefresh rejected');
    }
  },
}));

import { Rslint } from '../../../src/stacks/lint/Rslint';
import { createRslintController } from '../../../src/stacks/lint';

it('reconciles documents on every detection pass even while a config refresh is hung', async () => {
  const folder = {
    name: 'project',
    uri: { fsPath: '/project', toString: () => 'file:///project' },
  };
  const entry = { folder, stacks: { rslint: { mode: 'native' } } };
  const snapshot = {
    forFolder: () => entry,
    foldersFor: () => [entry],
  } as unknown as DetectionSnapshot;
  let onDetection!: (snapshot: DetectionSnapshot) => void;
  const controller = createRslintController();
  await controller.register({
    detection: snapshot,
    onDidChangeDetection: (listener: typeof onDetection) => {
      onDetection = listener;
      return { dispose() {} };
    },
    output: { debug() {}, info() {}, warn() {}, error() {} },
    status: { report() {} },
  } as unknown as StackContext);
  const runtime = runtimeFactory({
    key: 'core',
    workspaceFolder: folder,
    installation: { mode: 'native', packageDirectory: '/project/core' },
  } as unknown as ResolvedCoreRuntime);
  const hung = Promise.withResolvers<void>();
  const retry = rs
    .spyOn(runtime, 'retryConfigDependency')
    .mockReturnValue(hung.promise);
  const before = reconciles;
  try {
    onDetection(snapshot);
    await Promise.resolve();
    expect(reconciles).toBe(before + 1);
    onDetection(snapshot);
    await Promise.resolve();
    expect(reconciles).toBe(before + 2);
  } finally {
    hung.resolve();
    retry.mockRestore();
  }
});

it('updates a surviving bridge runtime attribution before the next config failure', async () => {
  const folder = {
    name: 'project',
    uri: { fsPath: '/project', toString: () => 'file:///project' },
  };
  const snapshot = (configPath: string): DetectionSnapshot => {
    const entry = {
      folder,
      rootRstackConfigPath: configPath,
      stacks: { rslint: { mode: 'bridged' } },
    };
    return {
      forFolder: () => entry,
      foldersFor: () => [entry],
    } as unknown as DetectionSnapshot;
  };
  let onDetection!: (snapshot: DetectionSnapshot) => void;
  const warnings: string[] = [];
  const states: StackState[] = [];
  const controller = createRslintController();
  await controller.register({
    detection: snapshot('/project/rstack.config.js'),
    onDidChangeDetection: (listener: typeof onDetection) => {
      onDetection = listener;
      return { dispose() {} };
    },
    output: { warn: (message: string) => warnings.push(message) },
    status: { report: (state: StackState) => states.push(state) },
  } as unknown as StackContext);
  const shimPath = '/project/node_modules/rstack/dist/rslintConfig.js';
  const runtime = runtimeFactory({
    key: 'bridge',
    workspaceFolder: folder,
    installation: {
      mode: 'bridged',
      packageDirectory: '/project/core',
      shimPath,
    },
  } as unknown as ResolvedCoreRuntime);

  onDetection(snapshot('/project/rstack.config.ts'));
  // Deliver the next worker verdict to the same runtime, not a replacement.
  (
    runtime as unknown as { handleConfigDependencyStatus(value: unknown): void }
  ).handleConfigDependencyStatus({
    kind: 'missing',
    failure: { configPath: shimPath, cause: "Cannot find package 'missing'" },
  });
  expect(states.at(-1)).toMatchObject({
    kind: 'disabled',
    reason: expect.stringContaining('rstack.config.ts'),
  });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('Cannot load rstack.config.ts:');
  expect(warnings[0]).not.toContain('rstack.config.js');
});

function createRuntime() {
  const states: StackState[] = [];
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const runtime = new Rslint({
    rootKey: '/project/core',
    workspaceFolder: { name: 'project', uri: { fsPath: '/project' } },
    installation: { mode: 'native', packageDirectory: '/project/core' },
    router: { createMiddleware: () => ({}) },
    logger: {
      info() {},
      debug() {},
      warn: (message: string) => warnings.push(message),
      error: (...args: unknown[]) => errors.push(args),
    },
    reportStatus: (state: StackState) => states.push(state),
  } as unknown as RslintOptions);

  return { runtime, states, warnings, errors };
}

it('keeps dependency retries single-flight until a hung refresh settles', async () => {
  refreshOutcome = 'missing';
  const { runtime, states } = createRuntime();
  await runtime.start(new AbortController().signal);
  const gate = Promise.withResolvers<void>();
  pendingRefresh = gate.promise;
  const before = refreshCalls;
  const first = runtime.retryConfigDependency();
  try {
    await rs.waitUntil(() => refreshCalls === before + 1);
    for (let tick = 0; tick < 5; tick++) {
      expect(runtime.retryConfigDependency()).toBeUndefined();
    }
    expect(refreshCalls).toBe(before + 1);
  } finally {
    pendingRefresh = undefined;
    refreshOutcome = 'fixed';
    gate.resolve();
    await first;
  }
  await runtime.retryConfigDependency();
  expect(refreshCalls).toBe(before + 2);
  expect(states.at(-1)?.kind).toBe('running');
});

it('keeps an initialized runtime disabled when initial configRefresh rejects', async () => {
  refreshOutcome = 'missing';
  const { runtime, states, warnings, errors } = createRuntime();

  await runtime.start(new AbortController().signal);
  expect(states.at(-1)?.kind).toBe('disabled');
  expect(states.some((state) => state.kind === 'crashed')).toBe(false);
  expect(warnings).toHaveLength(1);
  expect(errors).toEqual([]);
  await expect(runtime.retryConfigDependency()).rejects.toThrow(
    'configRefresh rejected',
  );
  expect(warnings).toHaveLength(1);

  refreshOutcome = 'broken';
  const beforeBroken = states.length;
  await runtime.retryConfigDependency();
  expect(states.slice(beforeBroken).map((state) => state.kind)).toEqual([
    'crashed',
  ]);
  expect(runtime.hasConfigDependencyFailure()).toBe(false);
  expect(errors).toEqual([
    ['Failed to refresh config discovery: Invalid config'],
  ]);

  await runtime.retryConfigDependency();
  expect(errors).toEqual([
    ['Failed to refresh config discovery: Invalid config'],
  ]);

  refreshOutcome = 'fixed';
  await runtime.retryConfigDependency();
  expect(states.at(-1)?.kind).toBe('running');
  expect(errors).toHaveLength(1);

  refreshOutcome = 'changed';
  await expect(
    (
      runtime as unknown as {
        requestConfigRefresh(reason: string): Promise<void>;
      }
    ).requestConfigRefresh('initial'),
  ).rejects.toThrow('config changed while loading');
});

it('recovers a startup config source race without a crash or error log', async () => {
  refreshOutcome = 'changed-once';
  const { runtime, states, errors } = createRuntime();
  await runtime.start(new AbortController().signal);
  expect(states.some((state) => state.kind === 'crashed')).toBe(false);
  expect(states.at(-1)?.kind).toBe('running');
  expect(errors).toEqual([]);
});

it('reports one startup crash when the config source retry is exhausted', async () => {
  refreshOutcome = 'changed';
  const { runtime, states, errors } = createRuntime();
  await expect(runtime.start(new AbortController().signal)).rejects.toThrow(
    'config changed while loading',
  );
  expect(states.filter((state) => state.kind === 'crashed')).toHaveLength(1);
  expect(errors).toHaveLength(1);
});
