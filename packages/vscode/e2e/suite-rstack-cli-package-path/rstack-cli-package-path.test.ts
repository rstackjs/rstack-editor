// The #103 layout end to end: `rstack.config.ts` at the folder root, `rstack`
// installed only under `infra/`, and `rstack.rstackCli.packagePath` pointing at
// it (`.vscode/settings.json`). `e2e/runTest.ts` runs this from a copy outside
// the repository, so no `node_modules` walk-up can find any `rstack`: every
// stack that works here found it through the setting.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { findPackageJsonUncached } from '../../src/shared/packageResolve';
import { RSTACK_PACKAGE_PATH_SETTING } from '../../src/shared/rstackPackage';
import type { RstackExtensionExports } from '../../src/types';
import {
  diagnosticRuleIdIncludes,
  waitForRslintDiagnostics,
} from '../lint/utils/diagnostics';
import {
  createCollectingMockRun,
  currentRstestExports,
  getTestItemByLabels,
  waitFor,
} from '../rstest/suite/helpers';
import { applyEdits, eventually } from '../suite/helpers';

const folder = (): vscode.WorkspaceFolder => {
  const [workspaceFolder] = vscode.workspace.workspaceFolders ?? [];
  assert.ok(workspaceFolder, 'the fixture workspace folder is unavailable');
  return workspaceFolder;
};

/** Where `infra/node_modules/rstack` really lives (the installed fixture). */
const infraStore = (): string =>
  fs.realpathSync(path.join(folder().uri.fsPath, 'infra', 'node_modules'));

let api: RstackExtensionExports;

suite('rstack.rstackCli.packagePath', () => {
  suiteSetup(async () => {
    const extension =
      vscode.extensions.getExtension<RstackExtensionExports>('rstack.rstack');
    assert.ok(extension, 'rstack.rstack is not installed in the test host');
    api = await extension.activate();
    // No `rstack` is reachable by walk-up from the sandbox copy; the precondition
    // that makes every assertion below about the setting.
    assert.equal(
      findPackageJsonUncached('rstack', folder().uri.fsPath),
      undefined,
      'a walk-up from the folder root reaches an rstack installation',
    );
  });

  test('formats through the configured rstack', async () => {
    const exports = await api.whenStackActive('fmt');
    const folderStates = exports.folderStates as () => Record<string, string>;
    await eventually(() => {
      assert.equal(folderStates()[folder().uri.fsPath], 'running');
    }, 'the rs fmt server to start');

    const uri = vscode.Uri.joinPath(folder().uri, 'src', 'needs-format.ts');
    const document = await vscode.workspace.openTextDocument(uri);
    // Retry: until the server's client registers its provider, VS Code's
    // built-in TypeScript formatter answers with different text.
    await eventually(async () => {
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatDocumentProvider',
        uri,
        { tabSize: 2, insertSpaces: true },
      );
      assert.ok(edits && edits.length > 0, 'expected formatting edits');
      // Prettier's quote normalization: VS Code's built-in formatter cannot
      // produce it, so a fallback cannot satisfy this.
      assert.equal(
        applyEdits(document, edits),
        'const answer = { value: "42" };\n',
      );
    }, 'rs fmt to format the document');
  });

  test('lints through the configured rstack and its @rslint/core', async () => {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(folder().uri, 'src', 'index.ts'),
    );
    await vscode.window.showTextDocument(document);
    await waitForRslintDiagnostics(document, (diagnostics) =>
      diagnostics.some((diagnostic) =>
        diagnosticRuleIdIncludes(diagnostic, 'no-debugger'),
      ),
    );

    const lint = api.getStackExports('rslint');
    assert.ok(lint, 'the Rslint stack should be active');
    const runtimes = (
      lint.getRuntimeStates as () => ReadonlyMap<string, unknown>
    )();
    // The runtime key carries the core and shim paths: both come from the
    // configured installation's store.
    assert.ok(
      [...runtimes.keys()].some((key) => key.includes(infraStore())),
      `expected a runtime on ${infraStore()}, got: ${[...runtimes.keys()].join(' | ')}`,
    );
  });

  test('discovers and runs bridged tests through the configured rstack', async () => {
    const { rstestInstance, item } = await waitFor(
      () => {
        const rstestInstance = currentRstestExports();
        return {
          rstestInstance,
          item: getTestItemByLabels(rstestInstance.testController.items, [
            'tests',
            'basic.test.ts',
          ]),
        };
      },
      { timeoutMs: 60_000 },
    );

    const sourceUri = vscode.Uri.joinPath(
      folder().uri,
      'rstack.config.ts',
    ).toString();
    const rstestPath = rstestInstance.getResolvedRstestPath(sourceUri);
    assert.ok(
      rstestPath?.startsWith(infraStore()),
      `expected rstack's own @rstest/core under ${infraStore()}, got: ${rstestPath}`,
    );

    const collecting = createCollectingMockRun();
    void rstestInstance.startTestRun(
      new vscode.TestRunRequest([item], undefined, rstestInstance.runProfile),
      new vscode.CancellationTokenSource().token,
      false,
      collecting.createMockRun,
    );
    await collecting.ended;
    assert.equal(collecting.failedMessages.length, 0, collecting.output);
    assert.deepEqual(
      collecting.passedItems.map((passed) => passed.label).sort(),
      ['basic.test.ts', 'trims a string'],
    );
  });

  test('falls back to not installed once the setting is cleared', async () => {
    // The setting is a restart trigger; the rebuilt fmt stack walks up again
    // and finds nothing.
    await vscode.workspace
      .getConfiguration(undefined, folder().uri)
      .update(
        RSTACK_PACKAGE_PATH_SETTING,
        undefined,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
    await eventually(async () => {
      const exports = await api.whenStackActive('fmt');
      const folderStates = exports.folderStates as () => Record<string, string>;
      assert.equal(folderStates()[folder().uri.fsPath], 'disabled');
    }, 'the fmt stack to report rstack as not installed');
  });
});
