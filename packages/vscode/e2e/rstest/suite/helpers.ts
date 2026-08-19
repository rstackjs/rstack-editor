// Ported from upstream `rstest/packages/vscode/tests/suite/helpers.ts`, plus
// the exports plumbing this extension needs: upstream's `activate()` returned
// the `Rstest` instance directly, while here the shell republishes the stack's
// exports through `RstackExtensionExports` (see `src/types.ts`).
import assert from 'node:assert';
import path from 'node:path';
import vscode from 'vscode';
import type { RstackExtensionExports } from '../../../src/types';

/**
 * The stack exports the suites consume — the shape
 * `stacks/test/index.ts#Rstest.buildExports()` returns.
 */
export interface RstestExports {
  testController: vscode.TestController;
  runProfile: vscode.TestRunProfile;
  getResolvedRstestPath: (sourceUri: string) => string | undefined;
  startTestRun: (
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    updateSnapshot?: boolean,
    createTestRun?: (request: vscode.TestRunRequest) => vscode.TestRun,
  ) => Promise<void>;
}

/** `<repo>/e2e/rstest/fixtures` (— `__dirname` is under `tests-dist/`). */
export const FIXTURES_ROOT = path.resolve(
  __dirname,
  '../../../..',
  'e2e/rstest/fixtures',
);

const EXTENSION_ID = 'rstack.rstack';

/**
 * Activates the extension (upstream: `getExtension('rstack.rstest')` +
 * `activate()`) and waits until the shell registered the Rstest stack.
 */
export async function getRstestExports(): Promise<RstestExports> {
  const extension =
    vscode.extensions.getExtension<RstackExtensionExports>(EXTENSION_ID);
  assert.ok(extension, `extension ${EXTENSION_ID} should be present`);
  const api = await extension.activate();
  return (await api.whenStackActive('rstest')) as unknown as RstestExports;
}

/**
 * The *current* Rstest exports, synchronously. The workspace suite drives
 * detection through states where the stack may be disposed and re-registered
 * (a re-registration publishes a fresh `TestController`), so its polling
 * probes must re-resolve the live controller instead of holding the first one.
 */
export function currentRstestExports(): RstestExports {
  const api =
    vscode.extensions.getExtension<RstackExtensionExports>(
      EXTENSION_ID,
    )?.exports;
  assert.ok(api, `extension ${EXTENSION_ID} should be activated`);
  const stackExports = api.getStackExports('rstest');
  assert.ok(stackExports, 'the Rstest stack should be active');
  return stackExports as unknown as RstestExports;
}

export async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Upstream's `waitFor`, made async-aware (a probe that returns a rejected
// promise is retried like a throwing one) — the assertions inside stay as-is.
export async function waitFor<T = void>(
  cb: () => T | Promise<T>,
  {
    timeoutMs = 20_000,
    pollMs = 25,
  }: {
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      return await cb();
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
    }
    await delay(pollMs);
  }
}

export function getTestItems(collection: vscode.TestItemCollection) {
  const items: vscode.TestItem[] = [];
  collection.forEach((item) => {
    items.push(item);
  });
  return items;
}

export function getProjectItems(testController: vscode.TestController) {
  const folders = getTestItems(testController.items);
  assert.equal(folders.length, 1);
  return getTestItems(folders[0].children);
}

export function getTestItemByLabels(
  collection: vscode.TestItemCollection,
  labels: string[],
) {
  const item = labels.reduce(
    (item, label) =>
      item &&
      getTestItems(item.children).find(
        // normalize to linux path style, matching `toLabelTree`, so labels
        // built with `path.sep` still match on Windows
        (child) => child.label.replaceAll(path.sep, '/') === label,
      ),
    {
      children: collection,
    } as vscode.TestItem | undefined,
  );
  assert.ok(item);
  return item;
}

// Helper: recursively transform a TestItem into a label-only tree.
// Children are sorted by label for stable comparisons.
export function toLabelTree(
  collection: vscode.TestItemCollection,
  fileOnly?: boolean,
): {
  label: string;
  children?: { label: string; children?: any[] }[];
}[] {
  const nodes: { label: string; children?: any[] }[] = [];
  collection.forEach((child) => {
    const children =
      child.label.match(/\.(test|spec)\.[cm]?[jt]sx?/) && fileOnly
        ? []
        : toLabelTree(child.children, fileOnly);
    // normalize to linux path style
    const label = child.label.replaceAll(path.sep, '/');
    nodes.push(children.length ? { label, children } : { label });
  });
  nodes.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return nodes;
}

/**
 * A collecting `vscode.TestRun` double for suites that only need "the run
 * ended — what passed, what failed, what was printed". Repo-local, not
 * ported: `progress.test.ts` keeps its own hand-rolled copy because it
 * resets the captures per `createMockRun` call and counts invocations,
 * which this deliberately does not do.
 */
export function createCollectingMockRun() {
  const deferred = Promise.withResolvers<null>();
  let output = '';
  const failedMessages: vscode.TestMessage[] = [];
  const passedItems: vscode.TestItem[] = [];
  const skippedItems: vscode.TestItem[] = [];

  const createMockRun = (): vscode.TestRun => ({
    isPersisted: true,
    name: '',
    token: new vscode.CancellationTokenSource().token,
    onDidDispose: new vscode.EventEmitter<void>().event,
    addCoverage: () => {},
    appendOutput: (message) => {
      output += message;
    },
    end: () => {
      deferred.resolve(null);
    },
    enqueued: () => {},
    errored: () => {},
    failed: (_test, message = []) => {
      failedMessages.push(...(message as vscode.TestMessage[]));
    },
    passed: (test) => {
      passedItems.push(test);
    },
    skipped: (test) => {
      skippedItems.push(test);
    },
    started: () => {},
  });

  return {
    createMockRun,
    /** Resolves when the run calls `end()`. */
    ended: deferred.promise,
    get output() {
      return output;
    },
    failedMessages,
    passedItems,
    skippedItems,
  };
}
