/**
 * The shell itself is the unit under test: `activate()` runs for real and the
 * commands it contributes are invoked through the recorded command registry,
 * the way VS Code would invoke them. Everything around it is stubbed — the
 * `vscode` namespace, detection, and the three stack factories — because unit
 * tests run in plain Node with no extension host (unit tests are Rstest, E2E is
 * Electron, and E2E stays the ground truth for editor behaviour).
 */
import { afterEach, beforeEach, describe, expect, it, rs } from '@rstest/core';
import type vscode from 'vscode';

interface FakeController {
  readonly restartOnSettings?: readonly string[];
  register(): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
}

const harness = rs.hoisted(() => {
  /**
   * Every field a test may set or read, rebuilt between tests. A factory rather
   * than a list of resets in `beforeEach`, so a field added here cannot leak
   * into the next test by being forgotten there.
   */
  const defaults = () => ({
    /** Stacks detection currently reports as detected. */
    detected: new Set<string>(),
    /** Stacks whose controller rejects in `register` / `dispose`. */
    failRegister: new Set<string>(),
    failDispose: new Set<string>(),
    /**
     * Stacks whose `dispose` blocks until released, so a test can hold a
     * teardown open and act while it is in flight — the Rslint client's
     * graceful-then-forced shutdown, in miniature.
     */
    blockDispose: new Map<string, Promise<void>>(),
    /** Stacks whose `dispose` has started but not yet returned. */
    disposing: new Set<string>(),
    /** Set once the shell tears down the output channels it owns. */
    channelsDisposed: false,
    /** Stacks whose `register` blocks until released. */
    blockRegister: new Map<string, Promise<void>>(),
    /** Stacks whose `register` has started but not yet returned. */
    registering: new Set<string>(),
    /**
     * Stacks whose teardown began while their own `register` was still in
     * flight — the signature of two passes running at once.
     */
    overlaps: [] as string[],
    /** Ordered `register:<stack>` / `dispose:<stack>` trace. */
    events: [] as string[],
    /** One entry per detection pass the shell asked for. */
    refreshes: 0,
    /** Everything the shell wrote to its own output channel. */
    shellLog: [] as string[],
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    contextKeys: new Map<string, boolean>(),
    /** What each stack's controller declares as restart-triggering settings. */
    restartOnSettings: new Map<string, readonly string[]>(),
    /** How often `runRestart` reset the host-scoped User Node memo. */
    nodeResets: 0,
    /** Every configuration listener the shell installed. */
    configListeners: [] as ((event: {
      affectsConfiguration(section: string): boolean;
    }) => void)[],
  });
  const state = {
    ...defaults(),
    reset(): void {
      Object.assign(state, defaults());
    },
    controller(stack: string): FakeController {
      return {
        restartOnSettings: state.restartOnSettings.get(stack),
        register: async () => {
          state.events.push(`register:${stack}`);
          const block = state.blockRegister.get(stack);
          if (block) {
            state.registering.add(stack);
            await block;
            state.registering.delete(stack);
          }
          if (state.failRegister.has(stack)) {
            throw new Error(`${stack} refuses to register`);
          }
          return { stack };
        },
        dispose: async () => {
          state.events.push(`dispose:${stack}`);
          if (state.registering.has(stack)) {
            state.overlaps.push(stack);
          }
          const block = state.blockDispose.get(stack);
          if (block) {
            state.disposing.add(stack);
            await block;
            state.disposing.delete(stack);
          }
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
  const disposable = { dispose: () => undefined };
  // Detection is stubbed out below, so nothing here ever fires the shell's
  // emitter — only its construction and disposal are reached.
  class EventEmitter {
    readonly event = () => disposable;
    fire(): void {}
    dispose(): void {}
  }
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
      dispose: () => {
        harness.channelsDisposed = true;
      },
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
      onDidChangeConfiguration: (
        listener: (event: {
          affectsConfiguration(section: string): boolean;
        }) => void,
      ) => {
        harness.configListeners.push(listener);
        return disposable;
      },
      onDidChangeWorkspaceFolders: () => disposable,
      onDidGrantWorkspaceTrust: () => disposable,
    },
  };
  return { ...vscode, default: vscode };
});

rs.mock('../src/detection', () => {
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

rs.mock('../src/stacks/lint', () => ({
  createRslintController: () => harness.controller('rslint'),
}));
rs.mock('../src/stacks/test', () => ({
  createRstestController: () => harness.controller('rstest'),
}));
rs.mock('../src/stacks/fmt', () => ({
  createFmtController: () => harness.controller('fmt'),
}));
rs.mock('../src/migration', () => ({
  maybePromptForMigration: async () => undefined,
  runSettingsMigration: async () => undefined,
}));
// The real reset is inert in tests; the harness counts the calls.
rs.mock('../src/shared/nodeResolution', () => ({
  resetUserNodeCaches: () => {
    harness.nodeResets += 1;
  },
}));

import { activate, deactivate } from '../src/extension';

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

/**
 * Fires a configuration change naming exactly one section, the way VS Code
 * reports one setting moving. Narrow on purpose: a fake that answered `true`
 * for every section could not tell a gate change from a restart-triggering one.
 */
const changeSetting = (...sections: string[]): void => {
  for (const listener of harness.configListeners) {
    listener({ affectsConfiguration: (asked) => sections.includes(asked) });
  }
};

/**
 * Lets every already-scheduled continuation run. A macrotask turn drains the
 * whole microtask queue behind it, so this is "whatever was going to happen
 * without further input has happened" — not a guess at a tick count.
 */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Restart is a shell concern, so *which settings trigger one* is too: a stack
 * declares `restartOnSettings` as data and the shell owns the listener and the

 * rebuild. These cases pin that seam — a stack watching configuration itself
 * would have to re-derive the gate exclusion and the mid-rebuild ordering the
 * shell already gets right.
 */
describe('restart-triggering settings', () => {
  beforeEach(async () => {
    harness.reset();
    harness.detected = new Set(['rslint', 'rstest', 'fmt']);
    harness.restartOnSettings = new Map([
      ['rstest', ['nodeExecutable']],
      ['rslint', ['binPath', 'customBinPath']],
    ]);
    await activate(context);
    harness.events.length = 0;
  });

  afterEach(async () => {
    await deactivate();
  });

  it("still rebuilds a stack when another stack's gate moved too", async () => {
    // One event covers a whole batch — saving settings.json moves everything
    // at once. A gate change used to short-circuit the whole listener, so the
    // restart was dropped on the floor with no trace.
    changeSetting('rstack.rslint.enable', 'rstack.rstest.nodeExecutable');
    await settle();
    expect(stacksOf('register')).toContain('rstest');
  });

  it('leaves a stack whose own gate moved to the reconcile', async () => {
    // Both moved for the same stack: rebuilding it here would fight a
    // reconcile that may be retiring it.
    changeSetting('rstack.rstest.enable', 'rstack.rstest.nodeExecutable');
    await settle();
    expect(stacksOf('register')).not.toContain('rstest');
  });

  it('rebuilds only the stack that declared the setting', async () => {
    changeSetting('rstack.rstest.nodeExecutable');
    await settle();
    expect(stacksOf('dispose')).toEqual(['rstest']);
    expect(stacksOf('register')).toEqual(['rstest']);
  });

  it('honours every setting a stack declares, not just the first', async () => {
    changeSetting('rstack.rslint.customBinPath');
    await settle();
    expect(stacksOf('register')).toEqual(['rslint']);
  });

  it('treats a declared rstack.* name as fully qualified, shared across stacks', async () => {
    // The shared runtime pin (`rstack.nodeExecutable`) lives outside any stack
    // namespace, so its declaration must not be re-prefixed into
    // `rstack.<stack>.rstack.nodeExecutable` — and one change event rebuilds
    // every stack that declared it.
    await deactivate();
    harness.reset();
    harness.detected = new Set(['rslint', 'rstest', 'fmt']);
    harness.restartOnSettings = new Map([
      ['rstest', ['rstack.nodeExecutable']],
      ['fmt', ['rstack.nodeExecutable']],
    ]);
    await activate(context);
    harness.events.length = 0;

    changeSetting('rstack.nodeExecutable');
    await settle();
    expect(stacksOf('dispose').sort()).toEqual(['fmt', 'rstest']);
    expect(stacksOf('register').sort()).toEqual(['fmt', 'rstest']);
  });

  it('ignores a setting no stack declared', async () => {
    changeSetting('rstack.rstest.nodeExecArgs');
    await settle();
    expect(harness.events).toEqual([]);
  });

  it('ignores a declared name under another stack namespace', async () => {
    // The section is built as `rstack.<stack>.<setting>`, so rslint's binPath
    // must not move rstest even though both are declared somewhere.
    changeSetting('rstack.rstest.binPath');
    await settle();
    expect(harness.events).toEqual([]);
  });

  it('leaves a stack behind a closed gate alone', async () => {
    // Only live controllers are iterated: there is nothing to rebuild for a
    // stack that never registered, and a restart would fight the gate.
    harness.detected = new Set(['rslint', 'fmt']);
    await run('rstack.restart');
    harness.events.length = 0;

    changeSetting('rstack.rstest.nodeExecutable');
    await settle();
    expect(harness.events).toEqual([]);
  });
});

describe('the shell restart command', () => {
  beforeEach(async () => {
    harness.reset();
    harness.detected = new Set(['rslint', 'rstest', 'fmt']);
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

  it('resets the shared Node memo only when no consumer stack survives the pass', async () => {
    // A single-stack fmt restart leaves the live Rstest controller standing
    // on the memoized runtime decision — the pass must not clear it under
    // the workers that already took it.
    await run('rstack.fmt.restart');
    expect(harness.nodeResets).toBe(0);

    // The full restart is the "like a window reload" gesture: every consumer
    // is rebuilt, so the memo goes with them.
    await restart();
    expect(harness.nodeResets).toBe(1);
  });

  it('resets the memo on a single-stack restart once it is the only consumer', async () => {
    harness.detected.delete('rstest');
    // Rstest retires through the gate; fmt is still live, so no reset yet.
    await run('rstack.rstest.restart');
    expect(harness.nodeResets).toBe(0);

    // fmt is now the only User-Node consumer and it is in the pass. The
    // surviving lint controller does not hold the memo alive: it runs on the
    // VS Code Node runtime and never reads it.
    await run('rstack.fmt.restart');
    expect(harness.nodeResets).toBe(1);
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

  it('serialises a restart invoked while activation is still running', async () => {
    // `registerCommands` runs before activation's first await, so the palette
    // can reach restart while activation is still bringing stacks up. If
    // activation's own reconcile does not ride the queue, the restart runs
    // straight through it and retires a controller whose `register()` has not
    // returned — that controller then goes on to publish its exports and flip
    // `active` on, having already been disposed.
    await deactivate();
    harness.events.length = 0;
    harness.refreshes = 0;
    harness.overlaps.length = 0;

    const blockedRegister = Promise.withResolvers<void>();
    harness.blockRegister.set('rslint', blockedRegister.promise);

    const activating = activate(context);
    await settle();
    expect(harness.registering.has('rslint')).toBe(true);

    const restarting = restart();
    await settle();

    // The restart must still be waiting its turn, not tearing down a stack
    // that is in the middle of coming up.
    expect(harness.overlaps).toEqual([]);

    blockedRegister.resolve();
    await Promise.all([activating, restarting]);
    expect(harness.overlaps).toEqual([]);
  });

  it('does not tear down shell resources while a restart is still disposing', async () => {
    // Covers the window `dispose()` documents: mid-restart the controller map
    // is already empty while the Rslint client is still shutting down, so a
    // teardown that only walked that map would pull the channels out from
    // under it.
    //
    // The assertion is on the channels rather than on deactivate's promise:
    // "has not resolved yet" is a race with the microtask queue, whereas "the
    // channel this teardown is still logging to is alive" is a fact.
    const blockedDispose = Promise.withResolvers<void>();
    harness.blockDispose.set('rslint', blockedDispose.promise);

    const restarting = restart();
    await settle();
    expect(harness.disposing.has('rslint')).toBe(true);

    const shutdown = deactivate();
    await settle();

    expect(harness.disposing.has('rslint')).toBe(true);
    expect(harness.channelsDisposed).toBe(false);

    blockedDispose.resolve();
    await Promise.all([restarting, shutdown]);
    expect(harness.disposing.has('rslint')).toBe(false);
    expect(harness.channelsDisposed).toBe(true);
  });
});
