// The opened workspace folder is `packages/app`; the fixture's only
// `rslint.config.*` sits two levels above it. The rslint CLI and its Go server
// walk up to the filesystem root for a config, so native lint detection must
// light this folder, and its ancestor watchers must keep that decision fresh.
import * as assert from 'assert';
import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs';
import {
  diagnosticRuleIdIncludes,
  waitForRslintDiagnostics as waitForDiagnostics,
} from '../utils/diagnostics';
import {
  extensionExports,
  waitForLintStackRegistration,
} from '../utils/extension';

const pollIntervalMs = 100;

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

  function workspaceFolder(): vscode.WorkspaceFolder {
    return vscode.workspace.workspaceFolders![0];
  }

  const folderPath = (): string => workspaceFolder().uri.fsPath;
  const rootConfigPath = (): string =>
    path.join(folderPath(), '..', '..', 'rslint.config.mjs');
  const nearerConfigPath = (): string =>
    path.join(folderPath(), '..', 'rslint.config.mjs');

  function ancestorConfigPath(): string | undefined {
    const exports = extensionExports().getStackExports('rslint') as
      | { getAncestorConfigPaths?: () => ReadonlyMap<string, string> }
      | undefined;
    return exports
      ?.getAncestorConfigPaths?.()
      .get(workspaceFolder().uri.toString());
  }

  async function waitForAncestorConfigPath(
    expected: string,
    timeoutMs = 60_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (ancestorConfigPath() === path.resolve(expected)) return;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    assert.strictEqual(ancestorConfigPath(), path.resolve(expected));
  }

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
    fs.rmSync(nearerConfigPath(), { force: true });
    fs.writeFileSync(rootConfigPath(), configWithNoDebugger('error'));
    await waitForAncestorConfigPath(rootConfigPath());
  });

  test('lints the folder with the config above it', async () => {
    await waitForAncestorConfigPath(rootConfigPath());
    const document = await openIndex();
    await waitForDiagnostics(document, hasNoDebugger);
  });

  test('refreshes diagnostics when the config above the folder changes', async () => {
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

  test('re-runs detection for a nearer config created above the folder', async () => {
    const document = await openIndex();
    await waitForDiagnostics(document, hasNoDebugger);

    fs.writeFileSync(nearerConfigPath(), configWithNoDebugger('off'));
    await waitForAncestorConfigPath(nearerConfigPath());
    await waitForDiagnostics(
      document,
      (diagnostics) => !hasNoDebugger(diagnostics),
    );

    fs.rmSync(nearerConfigPath());
    await waitForAncestorConfigPath(rootConfigPath());
    await waitForDiagnostics(document, hasNoDebugger);
  });

  test('stops linting when the config above the folder is deleted', async () => {
    fs.rmSync(rootConfigPath());
    await waitForLintStackRegistration(false);

    fs.writeFileSync(rootConfigPath(), configWithNoDebugger('error'));
    await waitForLintStackRegistration(true);
    await waitForAncestorConfigPath(rootConfigPath());
    const document = await openIndex();
    await waitForDiagnostics(document, hasNoDebugger);
  });
});
