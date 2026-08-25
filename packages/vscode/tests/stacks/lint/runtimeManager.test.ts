/**
 * The reconcile-during-start race (upstream lifecycle, rslint #1617 port):
 * a second `reconcile` of the same document while the first runtime start is
 * still in flight must not tear down and relaunch a runtime that resolves to
 * the very same key. Tearing it down mid-`initialize` is what surfaced
 * vscode-languageclient's force-notified "Server initialization failed" /
 * "couldn't create connection to server" toasts at activation, when the
 * register-time reconcile, a detection pass and `onDidOpenTextDocument` all
 * land within the worker's startup window.
 */
import { describe, expect, it, rs } from '@rstest/core';
import type { TextDocument, WorkspaceFolder } from 'vscode';

rs.mock('vscode', () => {
  const folder = {
    name: 'fixture',
    index: 0,
    uri: { toString: () => 'file:///project', fsPath: '/project' },
  };
  return {
    RelativePattern: class {},
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    workspace: {
      textDocuments: [] as unknown[],
      getWorkspaceFolder: () => folder,
      getConfiguration: () => ({ get: () => undefined }),
    },
  };
});

import {
  RuntimeManager,
  type ManagedRslintRuntime,
} from '../../../src/stacks/lint/RuntimeManager';
import type { ResolvedCoreRuntime } from '../../../src/stacks/lint/CoreResolver';
import type { WorkspaceDocumentRouter } from '../../../src/stacks/lint/WorkspaceDocumentRouter';

const folder = {
  name: 'fixture',
  index: 0,
  uri: { toString: () => 'file:///project', fsPath: '/project' },
} as unknown as WorkspaceFolder;

function documentOf(path: string): TextDocument {
  return {
    languageId: 'typescript',
    uri: {
      scheme: 'file',
      fsPath: path,
      toString: () => `file://${path}`,
    },
  } as unknown as TextDocument;
}

function resolvedCore(key: string): ResolvedCoreRuntime {
  return {
    key,
    workspaceFolder: folder,
    installation: { packageDirectory: '/project/node_modules/@rslint/core' },
  } as unknown as ResolvedCoreRuntime;
}

interface FakeRuntime {
  readonly runtime: ManagedRslintRuntime;
  releaseStart(): void;
  closes: number;
  aborted: boolean;
}

function fakeRuntime(): FakeRuntime {
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const fake: FakeRuntime = {
    releaseStart,
    closes: 0,
    aborted: false,
    runtime: {
      rootKey: 'core-key',
      workspaceFolder: folder,
      sendDocumentOpen: async () => undefined,
      sendDocumentClose: async () => undefined,
      clearDocumentDiagnostics: () => undefined,
      // Mirrors Rslint.start: the returned promise rejects on abort even
      // while the underlying startup work is still pending (raceWithAbort).
      async start(signal) {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              fake.aborted = true;
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error('aborted'),
              );
            },
            { once: true },
          );
          void startGate.then(resolve);
        });
      },
      async close() {
        fake.closes += 1;
      },
    },
  };
  return fake;
}

const routerStub = {
  assign: async () => undefined,
  activate: async () => undefined,
  deactivate: async () => undefined,
  closeAll: async () => undefined,
} as unknown as WorkspaceDocumentRouter;

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  error: () => undefined,
};

const WAIT = { timeout: 5_000, interval: 5 };

interface Harness {
  readonly manager: RuntimeManager;
  readonly runtimes: FakeRuntime[];
  readonly failures: unknown[];
  readonly state: { key: string; documentOpen: boolean };
}

function createHarness(): Harness {
  const runtimes: FakeRuntime[] = [];
  const failures: unknown[] = [];
  const state = { key: 'core-key', documentOpen: true };
  const manager = new RuntimeManager(
    routerStub,
    {
      clear: () => undefined,
      resolve: async () => resolvedCore(state.key),
    },
    () => {
      const entry = fakeRuntime();
      runtimes.push(entry);
      return entry.runtime;
    },
    silentLogger,
    {
      folderMode: () => 'bridged',
      documentIsOpen: () => state.documentOpen,
      onDocumentFailure: (failure) => failures.push(failure.error),
    },
  );
  return { manager, runtimes, failures, state };
}

/** Release start gates (from index `from` on) until `pending` settles. */
async function settleWithStartsReleased(
  harness: Harness,
  pending: Promise<unknown>,
  from = 0,
): Promise<void> {
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await rs.waitUntil(() => {
    for (const entry of harness.runtimes.slice(from)) entry.releaseStart();
    return settled;
  }, WAIT);
}

describe('RuntimeManager reconcile-during-start', () => {
  it('keeps the pending runtime when a second reconcile resolves to the same key', async () => {
    const harness = createHarness();
    const document = documentOf('/project/src/index.ts');
    const first = harness.manager.reconcile(document);
    await rs.waitUntil(() => harness.runtimes.length === 1, WAIT);

    // A detection pass / onDidOpen landing inside the startup window.
    const second = harness.manager.reconcile(document);
    await settleWithStartsReleased(harness, Promise.all([first, second]));

    expect(harness.failures).toEqual([]);
    expect(harness.runtimes.length).toBe(1);
    expect(harness.runtimes[0].closes).toBe(0);
    expect(harness.runtimes[0].aborted).toBe(false);

    await harness.manager.close();
  });

  it('cancels a pending start immediately when the resolution moves to another key', async () => {
    const harness = createHarness();
    const document = documentOf('/project/src/index.ts');
    const first = harness.manager.reconcile(document);
    await rs.waitUntil(() => harness.runtimes.length === 1, WAIT);

    // The core changed under a start that never settles (hung worker): the
    // superseding reconcile must abort it rather than queue behind it. Only
    // the replacement's gate is released; the first start stays hung.
    harness.state.key = 'other-core-key';
    const second = harness.manager.reconcile(document);
    await rs.waitUntil(() => harness.runtimes[0].aborted, WAIT);
    await settleWithStartsReleased(harness, Promise.all([first, second]), 1);

    expect(harness.failures).toEqual([]);
    expect(harness.runtimes.length).toBe(2);
    expect(harness.runtimes[0].closes).toBe(1);
    expect(harness.runtimes[1].aborted).toBe(false);
    expect(harness.runtimes[1].closes).toBe(0);

    await harness.manager.close();
  });

  it('releases the pending runtime when the document closes during start', async () => {
    const harness = createHarness();
    const document = documentOf('/project/src/index.ts');
    const first = harness.manager.reconcile(document);
    await rs.waitUntil(() => harness.runtimes.length === 1, WAIT);

    harness.state.documentOpen = false;
    harness.manager.documentClosed(document);
    await rs.waitUntil(() => harness.runtimes[0].closes === 1, WAIT);
    await first;

    expect(harness.failures).toEqual([]);
    expect(harness.runtimes.length).toBe(1);

    await harness.manager.close();
  });
});
