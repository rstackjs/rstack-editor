// The opened workspace folder is `packages/app`; the fixture's only
// `rslint.config.*` sits two levels above it, so native lint detection must
// light this folder from the ancestor config and keep that decision fresh.
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
  const nearerConfigPath = (): string =>
    path.join(folderPath(), '..', 'rslint.config.mjs');

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

  // On macOS, Node's directory `fs.watch` runs on one FSEventStream per
  // process, and libuv destroys and recreates that stream (from
  // `kFSEventStreamEventIdSinceNow`) whenever a directory watcher starts or
  // stops. VS Code's non-recursive watchers share one watcher process, so an
  // edit made while any other directory watcher starts can be lost by all of
  // them. Startup still churns watchers right after the first diagnostics (Go
  // registers its own ancestor watchers only once initialized), and macOS CI
  // lost the first edit there: the diagnostics never changed. Writing the same
  // content again, as a user saving twice would, re-signals the edit. The
  // diagnostics must still follow the file within the overall timeout.
  async function writeConfigUntilDiagnostics(
    document: vscode.TextDocument,
    filePath: string,
    content: string,
    predicate: (diagnostics: vscode.Diagnostic[]) => boolean,
  ): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      fs.writeFileSync(filePath, content);
      try {
        await waitForDiagnostics(
          document,
          predicate,
          Math.max(0, Math.min(10_000, deadline - Date.now())),
        );
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
    }
  }

  teardown(async () => {
    fs.rmSync(nearerConfigPath(), { force: true });
    fs.writeFileSync(rootConfigPath(), configWithNoDebugger('error'));
    await waitForLintStackRegistration(true);
  });

  test('lints with the config above the folder and follows its edits', async () => {
    const document = await openIndex();
    await waitForDiagnostics(document, hasNoDebugger);

    await writeConfigUntilDiagnostics(
      document,
      rootConfigPath(),
      configWithNoDebugger('off'),
      (diagnostics) => !hasNoDebugger(diagnostics),
    );

    await writeConfigUntilDiagnostics(
      document,
      rootConfigPath(),
      configWithNoDebugger('error'),
      hasNoDebugger,
    );
  });

  // The live runtime keeps its key; edits above the folder are picked up by
  // the extension's own config watchers and applied without a restart.
  test('applies a nearer config created above the folder while linting', async () => {
    const document = await openIndex();
    await waitForDiagnostics(document, hasNoDebugger);

    fs.writeFileSync(nearerConfigPath(), configWithNoDebugger('off'));
    await waitForDiagnostics(
      document,
      (diagnostics) => !hasNoDebugger(diagnostics),
    );

    fs.rmSync(nearerConfigPath());
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
