// NOT ported from upstream — upstream's extension predates the rstack bridge.
// This suite covers the bridged-project path end to end: a folder whose only
// test signal is `rstack.config.ts` (the `e2e/fixtures/rstack` fixture, shared
// with the `vscode` slice) must get a synthesized project driven
// through rstack's shipped shim, show the same node-less tree a native root
// config gets, and actually run its tests through the worker.
//
// The fixture folder is added as a second workspace folder and removed again
// in teardown: `suite/index.ts` collects `*.test.js` sorted, so this suite runs
// *first*, and every suite after it (`index`, `progress`, ...) asserts on the
// unwrapped single-folder tree the run starts with.
//
// Adding a folder also flips the tree into its wrapped layout, so the probes
// below re-resolve the live controller through `currentRstestExports()` — a
// detection change can deregister and re-register the stack, which publishes a
// fresh `TestController` (same reason as `workspace.test.ts`).
import assert from 'node:assert';
import path from 'node:path';
import vscode from 'vscode';
import {
  createCollectingMockRun,
  currentRstestExports,
  FIXTURES_ROOT,
  getRstestExports,
  getTestItemByLabels,
  toLabelTree,
  waitFor,
} from './helpers';

/** `<repo>/e2e/fixtures/rstack` — the rstack-cli fixture, no tool-native config. */
const RSTACK_FIXTURE = path.resolve(FIXTURES_ROOT, '../../fixtures/rstack');
const RSTACK_FIXTURE_URI = vscode.Uri.file(RSTACK_FIXTURE);

const WORKSPACE_1_FILES = [
  { label: 'each.test.ts' },
  { label: 'foo.test.ts' },
  { label: 'index.test.ts' },
  { label: 'jsFile.spec.js' },
  { label: 'jsxFile.test.jsx' },
  { label: 'progress.test.ts' },
  { label: 'tsxFile.test.tsx' },
];

suite('Rstack bridge suite', () => {
  suiteSetup(async () => {
    await getRstestExports();
    const added = vscode.workspace.updateWorkspaceFolders(
      vscode.workspace.workspaceFolders?.length || 0,
      0,
      { uri: RSTACK_FIXTURE_URI },
    );
    assert.ok(added, 'adding the rstack fixture folder should be accepted');
  });

  suiteTeardown(async () => {
    // Compare `uri.toString()`, not `fsPath`: `fsPath` lower-cases the Windows
    // drive letter while `path.resolve` keeps it as-is, so a raw string
    // compare can miss on Windows — and a missed removal here would leak the
    // folder into every later suite.
    const index = vscode.workspace.workspaceFolders?.findIndex(
      (folder) => folder.uri.toString() === RSTACK_FIXTURE_URI.toString(),
    );
    assert.ok(index !== undefined && index >= 0);
    const removed = vscode.workspace.updateWorkspaceFolders(index, 1);
    assert.ok(removed, 'removing the rstack fixture folder should be accepted');
    // Later suites assert on the unwrapped single-folder tree; leave only
    // after the controller has actually settled back into it.
    await waitFor(() => {
      const testController = currentRstestExports().testController;
      assert.deepStrictEqual(toLabelTree(testController.items, true), [
        { label: 'test', children: WORKSPACE_1_FILES },
      ]);
    });
  });

  test('discovers a bridged project from rstack.config.ts alone', async () => {
    // Two detected folders → both wrapped in workspace nodes. The rstack
    // folder holds a single bridged project whose source config sits at the
    // folder root under a default name, so it gets the node-less layout —
    // structurally identical to workspace-1's native root config. This is the
    // first suite this slice runs in a cold Electron, so the probe pays
    // workspace-1's discovery AND the bridged project's first worker spawn
    // (User Node, shim + `loadRstackConfig()`, Rstest/Rspack init) — hence
    // the extended budget (the mocha timeout is 120s).
    await waitFor(
      () => {
        const testController = currentRstestExports().testController;
        assert.deepStrictEqual(toLabelTree(testController.items, true), [
          {
            label: 'rstack',
            children: [
              {
                label: 'tests',
                children: [{ label: 'basic.test.ts' }],
              },
            ],
          },
          {
            label: 'workspace-1',
            children: [{ label: 'test', children: WORKSPACE_1_FILES }],
          },
        ]);
      },
      { timeoutMs: 60_000 },
    );

    // Test-case level (AST collection) inside the bridged project.
    await waitFor(() => {
      const testController = currentRstestExports().testController;
      const file = getTestItemByLabels(testController.items, [
        'rstack',
        'tests',
        'basic.test.ts',
      ]);
      assert.deepStrictEqual(toLabelTree(file.children), [
        { label: 'trims a string' },
      ]);
    });
  });

  test('runs bridged tests through the rstack config shim', async () => {
    const collecting = createCollectingMockRun();

    // Resolve the exports and the item together: holding an instance from
    // before the poll would keep a controller a re-registration had replaced.
    const { rstestInstance, item } = await waitFor(() => {
      const rstestInstance = currentRstestExports();
      return {
        rstestInstance,
        item: getTestItemByLabels(rstestInstance.testController.items, [
          'rstack',
          'tests',
          'basic.test.ts',
        ]),
      };
    });

    rstestInstance.startTestRun(
      new vscode.TestRunRequest([item], undefined, rstestInstance.runProfile),
      new vscode.CancellationTokenSource().token,
      false,
      collecting.createMockRun,
    );
    await collecting.ended;

    assert.equal(collecting.failedMessages.length, 0);
    // A file requested as a whole reports twice: the case itself
    // (`onTestCaseResult`) and the file item, which only goes green when the
    // whole file passed (`onTestFileResult`). `progress.test.ts` never sees the
    // second one — its file always has failures.
    assert.deepStrictEqual(
      collecting.passedItems.map((passed) => passed.label).sort(),
      ['basic.test.ts', 'trims a string'],
    );
    assert.match(collecting.output, /1 passed/);
  });
});
