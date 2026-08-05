import { afterEach, beforeEach, describe, expect, it, rs } from '@rstest/core';
import type vscode from 'vscode';

/**
 * The shell itself is the unit under test: `activate()` runs for real and the
 * commands it contributes are invoked through the recorded command registry,
 * the way VS Code would invoke them. Everything around it is stubbed — the
 * `vscode` namespace, detection, and the three stack factories — because unit
 * tests run in plain Node with no extension host (unit tests are Rstest, E2E is
 * Electron, and E2E stays the ground truth for editor behaviour).
 */
interface FakeController {
  register(): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
}

const harness = rs.hoisted(() => {
  const state = {
    /** Stacks detection currently reports as detected. */
    detected: new Set<string>(),
    /** Stacks whose controller rejects in `register` / `dispose`. */
    failRegister: new Set<string>(),
    failDispose: new Set<string>(),
    /** Ordered `register:<stack>` / `dispose:<stack>` trace. */
    events: [] as string[],
    /** One entry per detection pass the shell asked for. */
    refreshes: 0,
    /** Everything the shell wrote to its own output channel. */
    shellLog: [] as string[],
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    contextKeys: new Map<string, boolean>(),
    controller(stack: string): FakeController {
      return {
        register: async () => {
          state.events.push(`register:${stack}`);
          if (state.failRegister.has(stack)) {
            throw new Error(`${stack} refuses to register`);
          }
          return { stack };
        },
        dispose: async () => {
          state.events.push(`dispose:${stack}`);
          if (state.failDispose.has(stack)) {
            throw new Error(`${stack} refuses to dispose`);
          }
        },
      };
    },
  };
  return state;
});

rs.mock('vscode', () => {
  class EventEmitter {
    readonly #listeners = new Set<(value: unknown) => void>();
    readonly event = (listener: (value: unknown) => void) => {
      this.#listeners.add(listener);
      return {
        dispose: () => {
          this.#listeners.delete(listener);
        },
      };
    };
    fire(value: unknown): void {
      for (const listener of [...this.#listeners]) {
        listener(value);
      }
    }
    dispose(): void {
      this.#listeners.clear();
    }
  }
  const disposable = { dispose: () => undefined };
  const createOutputChannel = (name: string) => {
    // Only the shell channel is recorded — the failure reports the user is
    // supposed to find live there.
    const record = (level: string, message: string) => {
      if (name === 'Rstack') {
        harness.shellLog.push(`${level}: ${message}`);
      }
    };
    return {
      name,
      info: (message: string) => record('info', message),
      warn: (message: string) => record('warn', message),
      error: (message: string) => record('error', message),
      show: () => undefined,
      dispose: () => undefined,
    };
  };
  const vscode = {
    EventEmitter,
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class {
      constructor(readonly id: string) {}
    },
    MarkdownString: class {
      value = '';
      isTrusted = false;
      appendMarkdown(text: string): this {
        this.value += text;
        return this;
      }
    },
    window: {
      createOutputChannel,
      createStatusBarItem: () => ({
        name: '',
        text: '',
        tooltip: undefined as unknown,
        command: '',
        backgroundColor: undefined as unknown,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
      }),
      showInformationMessage: async () => undefined,
    },
    commands: {
      registerCommand: (
        command: string,
        handler: (...args: unknown[]) => unknown,
      ) => {
        harness.commands.set(command, handler);
        return {
          dispose: () => {
            harness.commands.delete(command);
          },
        };
      },
      executeCommand: async (command: string, ...args: unknown[]) => {
        if (command === 'setContext') {
          harness.contextKeys.set(String(args[0]), Boolean(args[1]));
          return undefined;
        }
        const handler = harness.commands.get(command);
        if (!handler) {
          throw new Error(`unknown command: ${command}`);
        }
        return handler(...args);
      },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [],
      getConfiguration: () => ({
        get: (_key: string, fallback?: unknown) => fallback,
      }),
      onDidChangeConfiguration: () => disposable,
      onDidChangeWorkspaceFolders: () => disposable,
      onDidGrantWorkspaceTrust: () => disposable,
    },
  };
  return { ...vscode, default: vscode };
});

rs.mock('./detection', () => {
  const snapshot = () => ({
    folders: [],
    isDetected: (stack: string) => harness.detected.has(stack),
    foldersFor: () => [],
    forFolder: () => undefined,
  });
  class DetectionService {
    readonly onDidChange = () => ({ dispose: () => undefined });
    get snapshot() {
      return snapshot();
    }
    async initialize() {
      return this.snapshot;
    }
    async refresh() {
      harness.refreshes += 1;
      return this.snapshot;
    }
    dispose() {}
  }
  return { DetectionService };
});

rs.mock('./stacks/lint', () => ({
  createRslintController: () => harness.controller('rslint'),
}));
rs.mock('./stacks/test', () => ({
  createRstestController: () => harness.controller('rstest'),
}));
rs.mock('./stacks/fmt', () => ({
  createFmtController: () => harness.controller('fmt'),
}));
rs.mock('./migration', () => ({
  maybePromptForMigration: async () => undefined,
  runSettingsMigration: async () => undefined,
}));

import { activate, deactivate } from './extension';

const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

const stacksOf = (kind: 'register' | 'dispose'): string[] =>
  harness.events
    .filter((event) => event.startsWith(`${kind}:`))
    .map((event) => event.slice(kind.length + 1))
    .sort();

const phasesOf = (): string[] =>
  harness.events.map((event) => event.split(':')[0]);

const run = async (command: string): Promise<void> => {
  const handler = harness.commands.get(command);
  if (!handler) {
    throw new Error(`${command} is not registered`);
  }
  await handler();
};

const restart = (): Promise<void> => run('rstack.restart');

describe('the shell restart command', () => {
  beforeEach(async () => {
    harness.detected = new Set(['rslint', 'rstest', 'fmt']);
    harness.failRegister.clear();
    harness.failDispose.clear();
    harness.events.length = 0;
    harness.refreshes = 0;
    harness.shellLog.length = 0;
    harness.commands.clear();
    harness.contextKeys.clear();
    await activate(context);
    expect(stacksOf('register')).toEqual(['fmt', 'rslint', 'rstest']);
    harness.events.length = 0;
    harness.refreshes = 0;
    harness.shellLog.length = 0;
  });

  afterEach(async () => {
    await deactivate();
  });

  it('is contributed unconditionally, so it is reachable with no stack active', () => {
    expect(harness.commands.has('rstack.restart')).toBe(true);

    // The command exists for the state where nothing is active, so the palette
    // must offer it then. VS Code hides a contributed command from the palette
    // only through a `contributes.menus.commandPalette` entry whose `when` is
    // false — every other `rstack.*` command has one, so the guard here is the
    // *absence* of an entry, which is exactly the kind of thing a later edit
    // adds back by symmetry.
    const manifest = require('../package.json') as {
      contributes: {
        commands: Array<{ command: string }>;
        menus: { commandPalette: Array<{ command: string; when: string }> };
      };
    };
    expect(
      manifest.contributes.commands.map((entry) => entry.command),
    ).toContain('rstack.restart');
    expect(
      manifest.contributes.menus.commandPalette.map((entry) => entry.command),
    ).not.toContain('rstack.restart');

    // The per-stack ones are the opposite: they only make sense for a stack
    // that is up, so each is gated on its own context key.
    for (const stack of ['rslint', 'rstest', 'fmt']) {
      expect(harness.commands.has(`rstack.${stack}.restart`)).toBe(true);
      expect(
        manifest.contributes.menus.commandPalette.find(
          (entry) => entry.command === `rstack.${stack}.restart`,
        )?.when,
      ).toBe(`rstack.${stack}.active`);
    }
  });

  it('rebuilds only the named stack on rstack.<stack>.restart', async () => {
    await run('rstack.rstest.restart');

    expect(stacksOf('dispose')).toEqual(['rstest']);
    expect(stacksOf('register')).toEqual(['rstest']);
    expect(phasesOf()).toEqual(['dispose', 'register']);
    // Detection is global and cheap, and the point of the command is that a
    // stale resolution gets redone — so it re-runs even for a single stack.
    expect(harness.refreshes).toBe(1);
    expect(harness.contextKeys.get('rstack.rstest.active')).toBe(true);
  });

  it('leaves a single-stack restart to the gate, same as a full one', async () => {
    harness.detected.delete('rstest');

    await run('rstack.rstest.restart');

    expect(stacksOf('dispose')).toEqual(['rstest']);
    expect(stacksOf('register')).toEqual([]);
    expect(harness.contextKeys.get('rstack.rstest.active')).toBe(false);
  });

  it('disposes every registered stack and rebuilds the ones that still pass the gate', async () => {
    harness.detected.delete('fmt');

    await restart();

    expect(stacksOf('dispose')).toEqual(['fmt', 'rslint', 'rstest']);
    expect(stacksOf('register')).toEqual(['rslint', 'rstest']);
    // A full reset: nothing is rebuilt before everything is torn down.
    expect(phasesOf()).toEqual([
      'dispose',
      'dispose',
      'dispose',
      'register',
      'register',
    ]);
    expect(harness.contextKeys.get('rstack.fmt.active')).toBe(false);
    expect(harness.contextKeys.get('rstack.rslint.active')).toBe(true);
  });

  it('re-runs detection before rebuilding', async () => {
    await restart();
    expect(harness.refreshes).toBe(1);
  });

  it('rebuilds a stack whose detection did not move at all', async () => {
    // The whole point of the command: nothing observable changed, yet every
    // controller is replaced, because `node_modules` may have been.
    await restart();
    expect(stacksOf('dispose')).toEqual(['fmt', 'rslint', 'rstest']);
    expect(stacksOf('register')).toEqual(['fmt', 'rslint', 'rstest']);
  });

  it('restarts the other stacks when one throws while disposing', async () => {
    harness.failDispose.add('rslint');

    await restart();

    expect(stacksOf('dispose')).toEqual(['fmt', 'rslint', 'rstest']);
    expect(stacksOf('register')).toEqual(['fmt', 'rslint', 'rstest']);
    expect(
      harness.shellLog.some(
        (line) =>
          line.startsWith('error:') &&
          line.includes('Rslint failed to dispose'),
      ),
    ).toBe(true);
  });

  it('restarts the other stacks when one throws while registering', async () => {
    harness.failRegister.add('rstest');

    await restart();

    expect(stacksOf('register')).toEqual(['fmt', 'rslint', 'rstest']);
    expect(harness.contextKeys.get('rstack.rstest.active')).toBe(false);
    expect(harness.contextKeys.get('rstack.rslint.active')).toBe(true);
    expect(harness.contextKeys.get('rstack.fmt.active')).toBe(true);
    expect(
      harness.shellLog.some(
        (line) =>
          line.startsWith('error:') &&
          line.includes('Rstest failed to register'),
      ),
    ).toBe(true);
  });

  it('serialises concurrent invocations instead of interleaving them', async () => {
    await Promise.all([restart(), restart()]);

    expect(harness.refreshes).toBe(2);
    expect(phasesOf()).toEqual([
      'dispose',
      'dispose',
      'dispose',
      'register',
      'register',
      'register',
      'dispose',
      'dispose',
      'dispose',
      'register',
      'register',
      'register',
    ]);
  });
});
