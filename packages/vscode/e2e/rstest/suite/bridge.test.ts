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
import fs from 'node:fs';
import path from 'node:path';
import vscode from 'vscode';
import {
  createCollectingMockRun,
  currentRstestExports,
  FIXTURES_ROOT,
  getRstestExports,
  getTestItemByLabels,
  getTestItemsRecursive,
  toLabelTree,
  waitFor,
} from './helpers';

/** `<repo>/e2e/fixtures/rstack` — the rstack-cli fixture, no tool-native config. */
const RSTACK_FIXTURE = path.resolve(FIXTURES_ROOT, '../../fixtures/rstack');
const RSTACK_FIXTURE_URI = vscode.Uri.file(RSTACK_FIXTURE);

const addFixtureFolder = (uri: vscode.Uri) => {
  assert.ok(
    vscode.workspace.updateWorkspaceFolders(
      vscode.workspace.workspaceFolders?.length || 0,
      0,
      { uri },
    ),
  );
};
const removeFixtureFolder = (uri: vscode.Uri) => {
  // URI comparison also handles Windows drive-letter casing.
  const index = vscode.workspace.workspaceFolders?.findIndex(
    (folder) => folder.uri.toString() === uri.toString(),
  );
  assert.ok(index !== undefined && index >= 0);
  assert.ok(vscode.workspace.updateWorkspaceFolders(index, 1));
};

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
    addFixtureFolder(RSTACK_FIXTURE_URI);
  });

  suiteTeardown(async () => {
    removeFixtureFolder(RSTACK_FIXTURE_URI);
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

    const sourceUri = vscode.Uri.file(
      path.join(RSTACK_FIXTURE, 'rstack.config.ts'),
    ).toString();
    const rstestPath = currentRstestExports().getResolvedRstestPath(sourceUri);
    assert.ok(rstestPath, 'the bridged project should resolve @rstest/core');
    // The resolved path is realpath'd; compare against the physical fixture.
    assert.ok(
      rstestPath.startsWith(
        path.join(fs.realpathSync(RSTACK_FIXTURE), 'node_modules'),
      ),
      `expected the fixture's own @rstest/core, got: ${rstestPath}`,
    );
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

  test('publishes both projects but routes merged file and case runs to the owner', async () => {
    const fixture = path.resolve(
      FIXTURES_ROOT,
      '../../fixtures/rstest-ownership',
    );
    const fixtureUri = vscode.Uri.file(fixture);
    const testUri = vscode.Uri.file(
      path.join(fixture, 'host/tests/ownership.test.ts'),
    );
    addFixtureFolder(fixtureUri);
    const assertOwnership = () => {
      const exports = currentRstestExports();
      const folder = getTestItemByLabels(exports.testController.items, [
        'rstest-ownership',
      ]);
      const root = getTestItemByLabels(folder.children, ['rstack.config.ts']);
      const host = getTestItemByLabels(folder.children, ['host']);
      // Both configs publish their CLI scope, even where the files overlap.
      assert.ok(exports.getResolvedRstestPath(root.id));
      assert.ok(exports.getResolvedRstestPath(host.id));
      assert.equal(root.busy, false);
      assert.equal(host.busy, false);
      const files = getTestItemsRecursive(folder.children).filter(
        (item) =>
          item.uri?.toString() === testUri.toString() &&
          item.label === 'ownership.test.ts',
      );
      const matches = files.map((file) => {
        const ancestors: vscode.TestItem[] = [];
        for (let parent = file.parent; parent; parent = parent.parent) {
          ancestors.unshift(parent);
        }
        return { file, ancestors };
      });
      assert.equal(
        files.length,
        2,
        'both projects must publish their own copy of the same URI',
      );
      const rootFiles = matches.filter(({ ancestors }) =>
        ancestors.includes(root),
      );
      const hostFiles = matches.filter(({ ancestors }) =>
        ancestors.includes(host),
      );
      assert.equal(rootFiles.length, 1, 'expected one file under root');
      assert.equal(hostFiles.length, 1, 'expected one file under host');
      const rootFile = rootFiles[0].file;
      const hostFile = hostFiles[0].file;
      assert.equal(rootFile.children.size, 1);
      assert.equal(hostFile.children.size, 1);
      const rootCase = getTestItemByLabels(rootFile.children, [
        'uses the nested config and cwd',
      ]);
      const hostCase = getTestItemByLabels(hostFile.children, [
        'uses the nested config and cwd',
      ]);
      return { exports, root, rootFile, hostFile, rootCase, hostCase };
    };
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const { exports, root, rootFile, hostFile } = await waitFor(
        assertOwnership,
        {
          timeoutMs: 60_000,
        },
      );
      for (const kind of ['file', 'case']) {
        const { rootCase, hostCase } = assertOwnership();
        const include =
          kind === 'file' ? [rootFile, hostFile] : [rootCase, hostCase];
        const collecting = createCollectingMockRun();
        await exports.startTestRun(
          new vscode.TestRunRequest(include, undefined, exports.runProfile),
          cancellation.token,
          false,
          collecting.createMockRun,
        );
        await collecting.ended;
        assert.ok(
          collecting.passedItems.some(
            (item) =>
              item.parent === hostFile &&
              item.label === 'uses the nested config and cwd',
          ),
        );
        assert.equal(collecting.failedItems.length, 0);
        assert.deepStrictEqual(
          collecting.skippedItems,
          kind === 'file' ? [rootFile, rootCase] : [rootCase],
        );
        for (const records of [
          collecting.enqueuedItems,
          collecting.passedItems,
          collecting.failedItems,
        ]) {
          assert.ok(
            !records.some(
              (item) => item === rootFile || item.parent === rootFile,
            ),
          );
        }
      }
      // Project Run All keeps the root CLI scope, which lacks the host alias.
      const rootRun = createCollectingMockRun();
      await exports.startTestRun(
        new vscode.TestRunRequest([root], undefined, exports.runProfile),
        cancellation.token,
        false,
        rootRun.createMockRun,
      );
      await rootRun.ended;
      assert.ok(rootRun.failedItems.includes(rootFile));
      assert.match(
        rootRun.failedMessages
          .map((message) => String(message.message))
          .join('\n'),
        /@host-value/,
      );
      for (const records of [
        rootRun.enqueuedItems,
        rootRun.passedItems,
        rootRun.failedItems,
      ]) {
        assert.ok(
          !records.some(
            (item) => item === hostFile || item.parent === hostFile,
          ),
        );
      }
    } finally {
      cancellation.dispose();
      removeFixtureFolder(fixtureUri);
      await waitFor(() => {
        assert.equal(currentRstestExports().testController.items.size, 2);
        assert.ok(
          !vscode.workspace.workspaceFolders?.some(
            (folder) => folder.uri.toString() === fixtureUri.toString(),
          ),
        );
      });
    }
  });
});
