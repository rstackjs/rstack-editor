import { afterEach, beforeEach, expect, it, rs } from '@rstest/core';
import type {
  LanguageClientOptions,
  ShowMessageParams,
} from 'vscode-languageclient';
import type { StackContext, StackState } from '../../../src/types';

const FMT_SESSION_ERROR_PREFIX = 'rs fmt cannot format this workspace: ';

const clients: Array<{
  notify(message: ShowMessageParams): void;
  options: LanguageClientOptions;
}> = [];
const toasts: string[] = [];
rs.mock('vscode', () => ({
  default: {
    RelativePattern: class {},
    env: {},
    window: {
      showErrorMessage: (message: string) => toasts.push(message),
      showWarningMessage() {},
      showInformationMessage() {},
    },
    workspace: {
      createFileSystemWatcher: () => ({
        onDidCreate: () => ({ dispose() {} }),
        onDidChange: () => ({ dispose() {} }),
        onDidDelete: () => ({ dispose() {} }),
        dispose() {},
      }),
    },
  },
}));
rs.mock('../../../src/detection', () => ({
  RSTACK_CONFIG_GLOB: '**/rstack.config.*',
}));
rs.mock('../../../src/shared/nodeExecutableSetting', () => ({
  getConfiguredNodeExecutable: () => undefined,
}));
rs.mock('../../../src/shared/nodeResolution', () => ({
  resolveUserNodeOnce: async () => ({ executable: 'node' }),
}));
rs.mock('../../../src/shared/packageResolve', () => ({
  findPackageJsonUncached: () => '/project/node_modules/rstack/package.json',
  readPackageJson: () => ({ version: '0.7.2', bin: 'bin/rs.js' }),
}));
rs.mock('../../../src/stacks/lint/LanguageServerProcessOwner', () => ({
  LanguageServerProcessOwner: class {
    beginClose() {}
    async close() {}
  },
}));
rs.mock('vscode-languageclient/node', () => ({
  MessageType: { Error: 1, Warning: 2, Info: 3 },
  State: { Running: 2, Stopped: 1 },
  ShowMessageNotification: { type: 'window/showMessage' },
  LanguageClient: class {
    state = 2;
    notify!: (message: ShowMessageParams) => void;
    change!: (event: { newState: number }) => void;
    constructor(
      _id: string,
      _name: string,
      _server: unknown,
      readonly options: LanguageClientOptions,
    ) {
      clients.push(this);
    }
    onNotification(_method: unknown, callback: typeof this.notify) {
      this.notify = callback;
    }
    onDidChangeState(callback: typeof this.change) {
      this.change = callback;
      return { dispose() {} };
    }
    createDefaultErrorHandler() {
      return {};
    }
    async start() {
      this.change({ newState: 2 });
    }
    async dispose() {}
    async stop() {}
  },
}));

import { createFmtController } from '../../../src/stacks/fmt';

let controller: ReturnType<typeof createFmtController>;
let states: StackState[];
let errors: string[];
let warnings: string[];
let redetect: () => void;
beforeEach(async () => {
  clients.length = 0;
  toasts.length = 0;
  states = [];
  errors = [];
  warnings = [];
  const detection = {
    foldersFor: () => [
      {
        folder: { name: 'project', uri: { fsPath: '/project' } },
        rootRstackConfigPath: '/project/rstack.config.ts',
      },
    ],
  };
  controller = createFmtController();
  await controller.register({
    detection,
    onDidChangeDetection: (listener: (snapshot: typeof detection) => void) => {
      redetect = () => listener(detection);
      return { dispose() {} };
    },
    status: { report: (state: StackState) => states.push(state) },
    output: {
      info() {},
      debug() {},
      warn: (message: string) => warnings.push(message),
      error: (message: string) => errors.push(message),
    },
  } as unknown as StackContext);
  await rs.waitUntil(() => states.at(-1)?.kind === 'running');
});
afterEach(async () => {
  await controller.dispose();
});

async function format(editCount: number, duringRequest?: () => void) {
  const provide =
    clients.at(-1)!.options.middleware!.provideDocumentFormattingEdits!;
  return provide({} as never, {} as never, {} as never, async () => {
    duringRequest?.();
    return Array.from({ length: editCount }, () => ({}) as never);
  });
}

it('reports real session errors, deduplicates logs across restarts, and preserves protocol toasts', async () => {
  const message = {
    type: 1 as const,
    message: `${FMT_SESSION_ERROR_PREFIX}SyntaxError: Unexpected token\nstack trace`,
  };
  clients[0].notify(message);
  expect(states.at(-1)).toMatchObject({
    kind: 'crashed',
    detail: 'SyntaxError: Unexpected token',
  });
  expect(controller.hasFailedState()).toBe(true);
  expect(errors).toEqual(['SyntaxError: Unexpected token']);
  expect(toasts).toEqual([message.message]);
  clients[0].notify(message);
  expect(errors).toHaveLength(1);
  expect(toasts).toHaveLength(2);

  redetect();
  await rs.waitUntil(() => clients.length === 2);
  expect(states.at(-1)?.kind).toBe('crashed');
  clients[1].notify(message);
  expect(errors).toHaveLength(1);
  await format(0);
  expect(controller.hasFailedState()).toBe(true);
  await format(1, () => clients[1].notify(message));
  expect(controller.hasFailedState()).toBe(true);
  expect(errors).toHaveLength(1);
  await format(1);
  expect(states.at(-1)?.kind).toBe('running');
  expect(controller.hasFailedState()).toBe(false);
  clients[1].notify(message);
  expect(errors).toHaveLength(2);
  clients[1].notify({
    type: 1,
    message: `${FMT_SESSION_ERROR_PREFIX}Error: Different failure`,
  });
  expect(errors.at(-1)).toBe('Error: Different failure');
  expect(errors).toHaveLength(3);
});

it('keeps classified missing dependencies disabled with one warning and no toast', async () => {
  const message = {
    type: 1 as const,
    message: `${FMT_SESSION_ERROR_PREFIX}Error: Cannot find package 'missing'`,
  };
  clients[0].notify(message);
  clients[0].notify(message);
  expect(states.at(-1)?.kind).toBe('disabled');
  expect(warnings).toHaveLength(1);
  expect(errors).toEqual([]);
  expect(toasts).toEqual([]);
  await format(1);
  expect(states.at(-1)?.kind).toBe('running');
  clients[0].notify(message);
  expect(states.at(-1)?.kind).toBe('disabled');
  expect(warnings).toHaveLength(2);
});
