import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { RstackExtensionExports } from '../../../src/types';
import { eventually } from './helpers';

const EXTENSION_ID = 'rstack.rstack';
let provider: vscode.DocumentFormattingEditProvider;
let armedFilePath: () => string | undefined;
let lastServe: () => 'hot' | 'cold' | undefined;

const folderNamed = (name: string): vscode.WorkspaceFolder => {
  const folder = (vscode.workspace.workspaceFolders ?? []).find(
    (candidate) => candidate.name === name,
  );
  assert.ok(folder, `the ${name} fixture folder is not in the workspace`);
  return folder;
};

suite('fmt', () => {
  suiteSetup(async () => {
    const extension =
      vscode.extensions.getExtension<RstackExtensionExports>(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
    const api = await extension.activate();
    const exports = await api.whenStackActive('fmt');
    assert.ok(exports.provider, 'the fmt stack did not export its provider');
    provider = exports.provider as vscode.DocumentFormattingEditProvider;
    assert.ok(
      typeof exports.armedFilePath === 'function',
      'the fmt stack did not export its standby hook',
    );
    armedFilePath = exports.armedFilePath as () => string | undefined;
    lastServe = exports.lastServe as () => 'hot' | 'cold' | undefined;
  });

  test('formats through the provider without touching the workspace', async () => {
    const uri = vscode.Uri.joinPath(
      folderNamed('rstack').uri,
      'src',
      'needs-format.ts',
    );
    const { document, edits } = await eventually(async () => {
      const document = await vscode.workspace.openTextDocument(uri);
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatDocumentProvider',
        uri,
        { tabSize: 2, insertSpaces: true },
      );
      assert.ok(edits && edits.length > 0, 'the formatter returned no edits');
      return { document, edits };
    }, 'the rs fmt provider to return an edit');

    const text = document.getText();
    let applied = text;
    // The command post-processes our single minimal edit through VS Code's
    // `computeMoreMinimalEdits`, so apply its result from the end backwards.
    for (const edit of [...edits].sort(
      (left, right) =>
        document.offsetAt(right.range.start) -
        document.offsetAt(left.range.start),
    )) {
      const start = document.offsetAt(edit.range.start);
      const end = document.offsetAt(edit.range.end);
      applied = applied.slice(0, start) + edit.newText + applied.slice(end);
    }
    // The quote normalization is Prettier-specific, so VS Code's built-in
    // TypeScript formatter cannot mask a failed Rstack provider via fallback.
    assert.equal(applied, 'const answer = { value: "42" };\n');
  });

  test('formats from the standby armed for the active editor', async () => {
    const uri = vscode.Uri.joinPath(
      folderNamed('rstack').uri,
      'src',
      'needs-format.ts',
    );
    // Showing the document is what arms the standby: the invariant is that the
    // standby tracks the active editor.
    const editor = await vscode.window.showTextDocument(uri);
    // Arming is debounced, and an earlier test may have left a standby on
    // another file, so poll until the armed file is this one.
    await eventually(() => {
      assert.equal(armedFilePath(), uri.fsPath);
    }, 'the standby to be armed for needs-format.ts');

    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      'vscode.executeFormatDocumentProvider',
      uri,
      { tabSize: 2, insertSpaces: true },
    );
    assert.ok(edits && edits.length > 0, 'the formatter returned no edits');

    const text = editor.document.getText();
    let applied = text;
    // The command post-processes our single minimal edit through VS Code's
    // `computeMoreMinimalEdits`, so apply its result from the end backwards.
    for (const edit of [...edits].sort(
      (left, right) =>
        editor.document.offsetAt(right.range.start) -
        editor.document.offsetAt(left.range.start),
    )) {
      const start = editor.document.offsetAt(edit.range.start);
      const end = editor.document.offsetAt(edit.range.end);
      applied = applied.slice(0, start) + edit.newText + applied.slice(end);
    }
    assert.equal(applied, 'const answer = { value: "42" };\n');
    // The cold path produces the same text, so only this proves the request
    // actually consumed the standby.
    assert.equal(lastServe(), 'hot');
  });

  test('returns no edits for a folder where fmt is not detected', async () => {
    const uri = vscode.Uri.joinPath(
      folderNamed('rslint').uri,
      'src',
      'index.ts',
    );
    const document = await vscode.workspace.openTextDocument(uri);
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const edits = await provider.provideDocumentFormattingEdits(
        document,
        { tabSize: 2, insertSpaces: true },
        cancellation.token,
      );
      assert.ok(!edits || edits.length === 0);
    } finally {
      cancellation.dispose();
    }
  });
});
