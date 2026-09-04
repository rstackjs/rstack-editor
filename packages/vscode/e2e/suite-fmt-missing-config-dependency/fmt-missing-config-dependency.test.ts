import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { RstackExtensionExports } from '../../src/types';
import { eventually } from '../suite/helpers';

suite('fmt missing config dependency', () => {
  test('suppresses the server toast and reports disabled', async () => {
    const extension =
      vscode.extensions.getExtension<RstackExtensionExports>('rstack.rstack');
    assert.ok(extension, 'rstack.rstack is not installed in the test host');
    const api = await extension.activate();
    const exports = await api.whenStackActive('fmt');
    const folderStates = exports.folderStates as () => Record<string, string>;
    const suppressedConfigDependencyMessages =
      exports.suppressedConfigDependencyMessages as () => number;
    const configDependencyWarnings =
      exports.configDependencyWarnings as () => readonly string[];
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'fmt fixture workspace is unavailable');

    await eventually(() => {
      assert.equal(folderStates()[folder.uri.fsPath], 'running');
    }, 'the rs fmt server to start');

    const uri = vscode.Uri.joinPath(folder.uri, 'src', 'needs-format.ts');
    await vscode.workspace.openTextDocument(uri);
    await vscode.commands.executeCommand(
      'vscode.executeFormatDocumentProvider',
      uri,
      { tabSize: 2, insertSpaces: true },
    );

    await eventually(() => {
      assert.equal(folderStates()[folder.uri.fsPath], 'disabled');
    }, 'the fmt config dependency failure to become disabled');
    assert.equal(suppressedConfigDependencyMessages(), 1);
    const warnings = configDependencyWarnings();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /missing-fmt-config-dependency/);
    assert.ok(!warnings[0].includes('\n'), 'warning must remain one line');
  });
});
