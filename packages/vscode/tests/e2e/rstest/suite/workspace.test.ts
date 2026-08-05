// Ported from upstream `rstest/packages/vscode/tests/suite/workspace.test.ts`.
//
// Adaptations beyond the namespace (`rstack.rstest` settings section):
//
// - Detection enables a stack per folder: upstream scanned
//   *every* workspace folder and kept an empty workspace node for a folder
//   with no matching config. Here the shell's detection scopes the scan, so a
//   folder without a matching `rstest.config.*`/custom-glob config is not
//   merely empty — it is undetected and gets no `WorkspaceManager` at all.
//   Consequently (see `Rstest#refreshAllWorkspaces` in
//   `src/stacks/test/index.ts`) the wrap-in-workspace-node decision keys off
//   the number of *detected* folders, not `workspaceFolders.length`: whenever
//   exactly one folder remains detected its tree is shown unwrapped. The
//   intermediate expectations below are adapted to that intended behavior;
//   the multi-folder expectations are upstream's, unchanged.
// - Detection changes can deregister and re-register the whole stack, which
//   publishes a fresh `TestController`; the polling probes therefore
//   re-resolve the live controller via `currentRstestExports()` instead of
//   holding the first one.
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import vscode from 'vscode';
import {
  currentRstestExports,
  FIXTURES_ROOT,
  getRstestExports,
  getTestItemByLabels,
  toLabelTree,
  waitFor,
} from './helpers';

// The unwrapped single-folder tree of workspace-1 (the standard layout: one
// root `rstest.config.ts`, so no workspace node and no project node).
const WORKSPACE_1_UNWRAPPED = [
  {
    label: 'test',
    children: [
      { label: 'each.test.ts' },
      { label: 'foo.test.ts' },
      { label: 'index.test.ts' },
      { label: 'jsFile.spec.js' },
      { label: 'jsxFile.test.jsx' },
      { label: 'progress.test.ts' },
      { label: 'tsxFile.test.tsx' },
    ],
  },
];

suite('Workspace discover suite', () => {
  test('Extension should discover workspaces and projects', async () => {
    await getRstestExports();

    const config = vscode.workspace.getConfiguration('rstack.rstest');
    const fixturesRoot = FIXTURES_ROOT;

    // initial workspaces
    await waitFor(() => {
      const testController = currentRstestExports().testController;
      assert.deepStrictEqual(
        toLabelTree(testController.items, true),
        WORKSPACE_1_UNWRAPPED,
      );
    });

    // add workspace-2
    vscode.workspace.updateWorkspaceFolders(
      vscode.workspace.workspaceFolders?.length || 0,
      0,
      {
        uri: vscode.Uri.file(path.resolve(fixturesRoot, 'workspace-2')),
      },
    );
    await waitFor(() => {
      const testController = currentRstestExports().testController;
      assert.deepStrictEqual(toLabelTree(testController.items, true), [
        {
          label: 'workspace-1',
          children: [
            {
              label: 'test',
              children: [
                { label: 'each.test.ts' },
                { label: 'foo.test.ts' },
                { label: 'index.test.ts' },
                { label: 'jsFile.spec.js' },
                { label: 'jsxFile.test.jsx' },
                { label: 'progress.test.ts' },
                { label: 'tsxFile.test.tsx' },
              ],
            },
          ],
        },
        {
          label: 'workspace-2',
          children: [
            {
              label: 'folder/project-2',
              children: [
                {
                  label: 'test',
                  children: [{ label: 'foo.test.ts' }],
                },
              ],
            },
            {
              label: 'project-1',
              children: [
                {
                  label: 'test',
                  children: [{ label: 'foo.test.ts' }],
                },
              ],
            },
          ],
        },
      ]);
    });

    // remove config file.
    // Upstream expected `workspace-2` to stay as an empty node. Adapted
    // (detection scopes per folder): with no matching config the folder is undetected and
    // dropped entirely, and workspace-1 — the only detected folder left —
    // is shown unwrapped again.
    await fs.rename(
      path.resolve(fixturesRoot, 'workspace-2/project-1/rstest.config.ts'),
      path.resolve(fixturesRoot, 'workspace-2/project-1/foo.config.ts'),
    );
    await fs.rename(
      path.resolve(
        fixturesRoot,
        'workspace-2/folder/project-2/rstest.config.ts',
      ),
      path.resolve(fixturesRoot, 'workspace-2/folder/project-2/bar.config.ts'),
    );
    await waitFor(() => {
      const testController = currentRstestExports().testController;
      assert.deepStrictEqual(
        toLabelTree(testController.items, true),
        WORKSPACE_1_UNWRAPPED,
      );
    });

    // change configFileGlobPattern.
    // Upstream expected an empty `workspace-1` node next to a wrapped
    // `workspace-2`. Adapted (detection scopes per folder): under the `foo.config.*` glob
    // workspace-1 is undetected and workspace-2 is the only detected folder,
    // so its single matching project is shown unwrapped.
    await config.update('configFileGlobPattern', [
      '**/foo.config.{mjs,ts,js,cjs,mts,cts}',
    ]);
    await waitFor(() => {
      const testController = currentRstestExports().testController;
      assert.deepStrictEqual(toLabelTree(testController.items, true), [
        {
          label: 'project-1',
          children: [
            {
              label: 'test',
              children: [{ label: 'foo.test.ts' }],
            },
          ],
        },
      ]);
    });

    // add config file.
    // Adapted like the step above: workspace-2 is still the only detected
    // folder, so its two projects are shown unwrapped.
    await fs.rename(
      path.resolve(fixturesRoot, 'workspace-2/folder/project-2/bar.config.ts'),
      path.resolve(fixturesRoot, 'workspace-2/folder/project-2/foo.config.ts'),
    );
    await waitFor(() => {
      const testController = currentRstestExports().testController;
      assert.deepStrictEqual(toLabelTree(testController.items, true), [
        {
          label: 'folder/project-2',
          children: [
            {
              label: 'test',
              children: [{ label: 'foo.test.ts' }],
            },
          ],
        },
        {
          label: 'project-1',
          children: [
            {
              label: 'test',
              children: [{ label: 'foo.test.ts' }],
            },
          ],
        },
      ]);
    });

    // restore config file and configFileGlobPattern
    await fs.rename(
      path.resolve(fixturesRoot, 'workspace-2/project-1/foo.config.ts'),
      path.resolve(fixturesRoot, 'workspace-2/project-1/rstest.config.ts'),
    );
    await fs.rename(
      path.resolve(fixturesRoot, 'workspace-2/folder/project-2/foo.config.ts'),
      path.resolve(
        fixturesRoot,
        'workspace-2/folder/project-2/rstest.config.ts',
      ),
    );
    await config.update('configFileGlobPattern', undefined);
    await waitFor(() => {
      const testController = currentRstestExports().testController;
      assert.deepStrictEqual(toLabelTree(testController.items, true), [
        {
          label: 'workspace-1',
          children: [
            {
              label: 'test',
              children: [
                { label: 'each.test.ts' },
                { label: 'foo.test.ts' },
                { label: 'index.test.ts' },
                { label: 'jsFile.spec.js' },
                { label: 'jsxFile.test.jsx' },
                { label: 'progress.test.ts' },
                { label: 'tsxFile.test.tsx' },
              ],
            },
          ],
        },
        {
          label: 'workspace-2',
          children: [
            {
              label: 'folder/project-2',
              children: [
                {
                  label: 'test',
                  children: [{ label: 'foo.test.ts' }],
                },
              ],
            },
            {
              label: 'project-1',
              children: [
                {
                  label: 'test',
                  children: [{ label: 'foo.test.ts' }],
                },
              ],
            },
          ],
        },
      ]);
    });

    // remove workspace-2
    vscode.workspace.updateWorkspaceFolders(1, 1);

    await waitFor(() => {
      const testController = currentRstestExports().testController;
      assert.deepStrictEqual(
        toLabelTree(testController.items, true),
        WORKSPACE_1_UNWRAPPED,
      );
    });
  });

  test('discovers test cases when project root has a trailing separator', async () => {
    await getRstestExports();

    const config = vscode.workspace.getConfiguration('rstack.rstest');
    const configFileGlobPattern = config.get<string[]>('configFileGlobPattern');
    assert.ok(configFileGlobPattern);
    await config.update('configFileGlobPattern', [
      ...configFileGlobPattern,
      '**/trailing-slash.config.ts',
    ]);

    try {
      await waitFor(() => {
        const testController = currentRstestExports().testController;
        const testFile = getTestItemByLabels(testController.items, [
          'config',
          'test',
          'foo.test.ts',
        ]);
        assert.ok(
          testFile.children.size > 0,
          'Test file should be associated with its test cases',
        );
      });
    } finally {
      await config.update('configFileGlobPattern', undefined);
    }
  });
});
