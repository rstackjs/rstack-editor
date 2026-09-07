import { expect, it, rs } from '@rstest/core';
import type { StackState } from '../../../src/types';
import type { RslintOptions } from '../../../src/stacks/lint/Rslint';

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

it('keeps an initialized runtime disabled when initial configRefresh rejects', async () => {
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

  await runtime.start(new AbortController().signal);
  expect(states.at(-1)?.kind).toBe('disabled');
  expect(states.some((state) => state.kind === 'crashed')).toBe(false);
  expect(warnings).toHaveLength(1);
  expect(errors).toEqual([]);
  await expect(runtime.retryConfigDependency()).rejects.toThrow(
    'configRefresh rejected',
  );
  expect(warnings).toHaveLength(1);
});
