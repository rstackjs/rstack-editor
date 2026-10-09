// The opened workspace folder is `packages/app`; the fixture's only
// `rslint.config.*` sits two levels above it. The rslint CLI and its Go server
// walk up to the filesystem root for a config, so native lint detection must
// light this folder, and its ancestor watchers must keep that decision fresh.
import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs';
import {
  diagnosticRuleIdIncludes,
  waitForRslintDiagnostics as waitForDiagnostics,
} from '../utils/diagnostics';
import { waitForLintStackRegistration } from '../utils/extension';

function configWithNoDebugger(severity: 'error' | 'off'): string {
  return `export default [
  {
    files: ['**/*.ts'],
    rules: {
      'no-debugger': '${severity}',
    },
  },
];
`;
}

suite('rslint config above the workspace folder', function () {
  this.timeout(120000);

  const folderPath = (): string =>
    vscode.workspace.workspaceFolders![0].uri.fsPath;
  const rootConfigPath = (): string =>
    path.join(folderPath(), '..', '..', 'rslint.config.mjs');

  async function openIndex(): Promise<vscode.TextDocument> {
    const document = await vscode.workspace.openTextDocument(
      path.join(folderPath(), 'src', 'index.ts'),
    );
    await vscode.window.showTextDocument(document);
    return document;
  }

  const hasNoDebugger = (diagnostics: vscode.Diagnostic[]): boolean =>
    diagnostics.some((diagnostic) =>
      diagnosticRuleIdIncludes(diagnostic, 'no-debugger'),
    );

  teardown(async () => {
    fs.writeFileSync(rootConfigPath(), configWithNoDebugger('error'));
    await waitForLintStackRegistration(true);
  });

  test('lints with the config above the folder and follows its edits', async () => {
    const document = await openIndex();
    await waitForDiagnostics(document, hasNoDebugger);

    fs.writeFileSync(rootConfigPath(), configWithNoDebugger('off'));
    await waitForDiagnostics(
      document,
      (diagnostics) => !hasNoDebugger(diagnostics),
    );

    fs.writeFileSync(rootConfigPath(), configWithNoDebugger('error'));
    await waitForDiagnostics(document, hasNoDebugger);
  });

  test('re-runs detection when the config above the folder is deleted or created', async () => {
    fs.rmSync(rootConfigPath());
    await waitForLintStackRegistration(false);

    fs.writeFileSync(rootConfigPath(), configWithNoDebugger('error'));
    await waitForLintStackRegistration(true);
    const document = await openIndex();
    await waitForDiagnostics(document, hasNoDebugger);
  });
});
