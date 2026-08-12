import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { RstackExtensionExports } from '../../src/types';
import { eventually } from './helpers';

const EXTENSION_ID = 'rstack.rstack';
/**
 * The fmt stack's E2E-only exports. They describe the folder set, not a
 * provider: the formatting provider is registered by vscode-languageclient from
 * each server's `documentFormattingProvider` capability, so the only thing the
 * stack itself can be asked about is which folders have a live server.
 */
let languages: readonly string[];
let formats: (fsPath: string) => boolean;
let folderStates: () => Record<string, string>;

const folderNamed = (name: string): vscode.WorkspaceFolder => {
  const folder = (vscode.workspace.workspaceFolders ?? []).find(
    (candidate) => candidate.name === name,
  );
  assert.ok(folder, `the ${name} fixture folder is not in the workspace`);
  return folder;
};

const fixtureFile = (folder: string, ...segments: string[]): vscode.Uri =>
  vscode.Uri.joinPath(folderNamed(folder).uri, ...segments);

/** Waits until the rstack fixture's `rs fmt` server covers the given file. */
const waitForCoverage = (uri: vscode.Uri): Promise<void> =>
  eventually(() => {
    assert.ok(
      formats(uri.fsPath),
      `${uri.fsPath} is not covered by a running rs fmt server`,
    );
  }, 'the rstack folder to have a running rs fmt server');

suite('fmt', () => {
  suiteSetup(async () => {
    const extension =
      vscode.extensions.getExtension<RstackExtensionExports>(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
    const api = await extension.activate();
    const exports = await api.whenStackActive('fmt');
    assert.ok(
      Array.isArray(exports.languages),
      'the fmt stack did not export its language list',
    );
    languages = exports.languages as readonly string[];
    assert.ok(
      typeof exports.formats === 'function',
      'the fmt stack did not export its coverage hook',
    );
    formats = exports.formats as (fsPath: string) => boolean;
    assert.ok(
      typeof exports.folderStates === 'function',
      'the fmt stack did not export its folder-state hook',
    );
    folderStates = exports.folderStates as () => Record<string, string>;
  });

  test('formats through the provider without touching the workspace', async () => {
    const uri = fixtureFile('rstack', 'src', 'needs-format.ts');
    // Deviation from the pre-LSP suite, in two parts. The stack no longer
    // registers a provider at activation: one appears only once the folder's
    // `rs fmt --lsp` server has started and its client has registered the
    // server's `documentFormattingProvider` capability. Until then VS Code's
    // built-in TypeScript formatter is the only candidate, and it answers
    // *successfully* — with single-quoted, non-Prettier text. So waiting for
    // "some edits" is not enough (that is what the built-in returns): the
    // suite waits for the folder's server first, and the retry loop asserts
    // the formatted text, not merely a non-empty edit list.
    await waitForCoverage(uri);

    const document = await eventually(async () => {
      const document = await vscode.workspace.openTextDocument(uri);
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatDocumentProvider',
        uri,
        { tabSize: 2, insertSpaces: true },
      );
      assert.ok(edits && edits.length > 0, 'the formatter returned no edits');

      let applied = document.getText();
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
      return document;
    }, 'the rs fmt language server to return a Prettier-formatted edit');

    // The server formats the buffer it was sent and returns edits; nothing on
    // disk may move, which is what "without touching the workspace" means.
    assert.equal(
      (await vscode.workspace.fs.readFile(uri)).toString(),
      "const   answer={value:'42'};\n",
    );
    // The document is only ever opened, never edited by the format request.
    assert.equal(document.isDirty, false);
  });

  test('covers only the folders where fmt is detected', async () => {
    // Replaces the pre-LSP "returns no edits for a folder where fmt is not
    // detected": there is no stack-owned provider left to call with a
    // foreign document. The equivalent question — is this path covered by a
    // running `rs fmt` server — is now the `formats` export, and it answers
    // per folder because a server's reach is its workspace folder.
    await waitForCoverage(fixtureFile('rstack', 'src', 'needs-format.ts'));

    // TypeScript, and one of the languages the stack claims, but fmt is not
    // detected for the rslint fixture — no server covers it.
    const uncovered = fixtureFile('rslint', 'src', 'index.ts');
    assert.ok(languages.includes('typescript'));
    assert.equal(formats(uncovered.fsPath), false);
  });

  test('runs one server for the detected folder and none for the others', async () => {
    await eventually(() => {
      assert.equal(
        folderStates()[folderNamed('rstack').uri.fsPath],
        'running',
        `folder states: ${JSON.stringify(folderStates())}`,
      );
    }, 'the rstack folder runtime to report running');

    const states = folderStates();
    // A runtime exists only for a folder detection lit, so the two fixtures
    // without an Rstack config must not appear at all — a stopped or crashed
    // entry for them would mean a server was spawned where none belongs.
    for (const name of ['rslint', 'rstest']) {
      assert.equal(
        folderNamed(name).uri.fsPath in states,
        false,
        `${name} has an rs fmt runtime: ${JSON.stringify(states)}`,
      );
    }
  });
});
