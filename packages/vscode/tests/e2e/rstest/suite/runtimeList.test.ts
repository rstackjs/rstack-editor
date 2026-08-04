// Ported from upstream `rstest/packages/vscode/tests/suite/runtimeList.test.ts`.
//
// Adaptations: exports via the shell's exports channel, and the settings
// section is `rstack.rstest` (unified namespace) instead of
// `rstest`. The expected label trees are upstream's, unchanged.
import assert from 'node:assert';
import vscode from 'vscode';
import {
  getRstestExports,
  getTestItemByLabels,
  toLabelTree,
  waitFor,
} from './helpers';

suite('Runtime list suite', () => {
  test('Extension should discover test cases from runtime', async () => {
    const rstestInstance = await getRstestExports();
    const testController = rstestInstance.testController;

    const config = vscode.workspace.getConfiguration('rstack.rstest');

    await waitFor(() => {
      const item = getTestItemByLabels(testController.items, [
        'test',
        'each.test.ts',
      ]);
      assert.deepStrictEqual(toLabelTree(item.children), [
        {
          children: [
            {
              label: 'case',
            },
          ],
          label: 'suite',
        },
        {
          label: 'unnamed test',
        },
        {
          label: 'unnamed test',
        },
      ]);
    });

    // change config to runtime
    await config.update('testCaseCollectMethod', 'runtime');
    await waitFor(() => {
      const item = getTestItemByLabels(testController.items, [
        'test',
        'each.test.ts',
      ]);
      assert.deepStrictEqual(toLabelTree(item.children), [
        {
          children: [
            {
              label: 'case',
            },
          ],
          label: 'suite',
        },
        {
          children: [
            {
              label: 'suite 1 case 1',
            },
            {
              label: 'suite 1 case 2',
            },
          ],
          label: 'suite 1',
        },
        {
          children: [
            {
              label: 'suite 2 case 1',
            },
            {
              label: 'suite 2 case 2',
            },
          ],
          label: 'suite 2',
        },
      ]);
    });

    // restore config
    await config.update('testCaseCollectMethod', undefined);
    await waitFor(() => {
      const item = getTestItemByLabels(testController.items, [
        'test',
        'each.test.ts',
      ]);
      assert.deepStrictEqual(toLabelTree(item.children), [
        {
          children: [
            {
              label: 'case',
            },
          ],
          label: 'suite',
        },
        {
          label: 'unnamed test',
        },
        {
          label: 'unnamed test',
        },
      ]);
    });

    // test list should be updated after test run
    rstestInstance.startTestRun(
      new vscode.TestRunRequest(
        undefined,
        undefined,
        rstestInstance.runProfile,
      ),
      new vscode.CancellationTokenSource().token,
      false,
    );
    await waitFor(
      () => {
        const item = getTestItemByLabels(testController.items, [
          'test',
          'each.test.ts',
        ]);
        assert.deepStrictEqual(toLabelTree(item.children), [
          {
            children: [
              {
                label: 'case',
              },
            ],
            label: 'suite',
          },
          {
            children: [
              {
                label: 'suite 1 case 1',
              },
              {
                label: 'suite 1 case 2',
              },
            ],
            label: 'suite 1',
          },
          {
            children: [
              {
                label: 'suite 2 case 1',
              },
              {
                label: 'suite 2 case 2',
              },
            ],
            label: 'suite 2',
          },
        ]);
      },
      { timeoutMs: 20_000 },
    );
  });
});
