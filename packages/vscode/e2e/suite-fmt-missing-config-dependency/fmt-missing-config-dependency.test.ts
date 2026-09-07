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
    const observedStates: string[] = [];
    const sampleState = (): string => {
      const state = folderStates()[folder.uri.fsPath];
      observedStates.push(state);
      return state;
    };

    await eventually(() => {
      const state = sampleState();
      assert.notEqual(
        state,
        'crashed',
        'rs fmt became crashed while waiting for running',
      );
      assert.equal(state, 'running');
    }, 'the rs fmt server to start');

    const uri = vscode.Uri.joinPath(folder.uri, 'src', 'needs-format.ts');
    await vscode.workspace.openTextDocument(uri);
    await vscode.commands.executeCommand(
      'vscode.executeFormatDocumentProvider',
      uri,
      { tabSize: 2, insertSpaces: true },
    );

    await eventually(() => {
      const state = sampleState();
      assert.notEqual(
        state,
        'crashed',
        'rs fmt became crashed while waiting for disabled',
      );
      assert.equal(state, 'disabled');
    }, 'the fmt config dependency failure to become disabled');
    // eventually retries thrown assertions, so retain every sample and check
    // outside it: a transient crash must not disappear behind later recovery.
    assert.ok(!observedStates.includes('crashed'), observedStates.join(' -> '));
    assert.equal(suppressedConfigDependencyMessages(), 1);
    const warnings = configDependencyWarnings();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /missing-fmt-config-dependency/);
    assert.ok(!warnings[0].includes('\n'), 'warning must remain one line');
  });
});
