import { expect, it, rs } from '@rstest/core';
import type { StackState } from '../../../src/types';
import type { RslintOptions } from '../../../src/stacks/lint/Rslint';
import { registerEditorProxy } from '../../../src/stacks/lint/worker/index';

let refreshOutcome:
  'missing' | 'broken' | 'fixed' | 'changed' | 'changed-once' = 'missing';

rs.mock('vscode', () => ({
  RelativePattern: class {},
  workspace: {
    createFileSystemWatcher: () => ({
      onDidCreate() {},
      onDidChange() {},
      onDidDelete() {},
    }),
  },
  env: {},
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
            beginConfigRefresh() {},
            takeConfigDependencyFailure: () => undefined,
            observeRefresh() {},
            requestStop() {},
          },
        );
        return request('rslint/configRefresh', { reason: 'initial' });
      }
      if (refreshOutcome !== 'missing') {
        this.notification?.({
          failure: null,
          ...(refreshOutcome === 'broken' ? { error: 'Invalid config' } : {}),
        });
        if (refreshOutcome === 'broken') throw new Error('Invalid config');
        return;
      }
      this.notification?.({
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

  refreshOutcome = 'fixed';
  // Config-file events use this same refresh path after dependency polling stops.
  await (
    runtime as unknown as {
      requestConfigRefresh(reason: string): Promise<void>;
    }
  ).requestConfigRefresh('config-change');
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
