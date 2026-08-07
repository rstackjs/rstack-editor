// Ported from upstream `rstest/packages/vscode/tests/suite/index.test.ts`.
//
// Adaptations: the extension is `rstack.rstack` and the Rstest internals are
// reached through the shell's exports channel (`whenStackActive('rstest')`)
// instead of `activate()`'s return value; upstream's fixed sleeps around
// discovery are replaced by bounded polling (`waitFor`) on the same
// assertions, because the fixture resolves the *published* `@rstest/core`
// from its own node_modules and a cold worker spawn can
// outlast the sleeps.
import assert from 'node:assert';
import vscode from 'vscode';
import {
  getProjectItems,
  getRstestExports,
  toLabelTree,
  waitFor,
} from './helpers';

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('Extension should discover test items', async () => {
    // Check if workspace is opened correctly
    const workspaceFolders = vscode.workspace.workspaceFolders;

    assert.ok(
      workspaceFolders && workspaceFolders.length > 0,
      'Workspace should be opened',
    );
    assert.ok(
      workspaceFolders[0].uri.path.includes('fixtures'),
      'Should open the fixtures workspace',
    );

    // Waits for the `onStartupFinished` activation and the shell registering
    // the Rstest stack (the `rstack.enable && rstack.rstest.enable &&
    // detected` gate).
    const rstestInstance = await getRstestExports();
    const testController = rstestInstance.testController;
    assert.ok(
      testController,
      'Test controller should be accessible through extension exports',
    );

    // focus on the testing view of this extension
    await vscode.commands.executeCommand('workbench.view.testing.focus');

    console.log(`Test controller found with ID: ${testController.id}`);

    // Assert that we have test items and check for specific items
    await waitFor(() => {
      assert.ok(
        testController.items.size > 0,
        'Test controller should have discovered test items',
      );
    });

    const { foo, index } = await waitFor(() => {
      const itemsArray = getProjectItems(testController);

      const foo = itemsArray.find((it) => it.id.endsWith('/test/foo.test.ts'));
      const index = itemsArray.find((it) =>
        it.id.endsWith('/test/index.test.ts'),
      );
      const jsSpec = itemsArray.find((it) =>
        it.id.endsWith('/test/jsFile.spec.js'),
      );
      const jsxFile = itemsArray.find((it) =>
        it.id.endsWith('/test/tsxFile.test.tsx'),
      );
      const tsxFile = itemsArray.find((it) =>
        it.id.endsWith('/test/tsxFile.test.tsx'),
      );

      assert.ok(foo, 'foo.test.ts should be discovered');
      assert.ok(index, 'index.test.ts should be discovered');
      assert.ok(jsSpec, 'jsFile.spec.js should be discovered');
      assert.ok(jsxFile, 'tsxFile.test.tsx should be discovered');
      assert.ok(tsxFile, 'tsxFile.test.tsx should be discovered');
      return { foo, index, jsSpec, jsxFile, tsxFile };
    });

    // Validate foo.test.ts structure via label-only tree. The test-case level
    // is filled in asynchronously by the AST collection, hence the polling.
    await waitFor(() => {
      const fooTree = toLabelTree(foo.children);
      assert.deepStrictEqual(fooTree, [
        {
          label: 'l1',
          children: [
            {
              label: 'l2',
              children: [
                {
                  label: 'l3',
                  children: [
                    { label: 'should also return "foo1"' },
                    { label: 'should return "foo1"' },
                  ],
                },
                { label: 'should also return "foo"' },
                { label: 'should return "foo"' },
              ],
            },
          ],
        },
      ]);
    });

    await waitFor(() => {
      const indexTree = toLabelTree(index.children);
      assert.deepStrictEqual(indexTree, [
        {
          label: 'Index',
          children: [
            { label: 'should add two numbers correctly' },
            { label: 'should test source code correctly' },
          ],
        },
      ]);
    });
  });
});
