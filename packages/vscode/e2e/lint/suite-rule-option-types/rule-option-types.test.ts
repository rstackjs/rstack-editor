// Ported verbatim from web-infra-dev/rslint
// `packages/vscode-extension/__tests__/suite-rule-option-types/rule-option-types.test.ts`
// at 760c4135.
import * as assert from 'assert';
import * as vscode from 'vscode';
import path from 'node:path';
import { waitForRslintDiagnostics } from '../utils/diagnostics';

// Exercises the rule-option types published by `@rslint/core` end to end: a
// value that type-checks must reach the lint rule at lint time, and an invalid
// one must be rejected by TypeScript in the config file.
suite('rslint generated rule-option types', function () {
  this.timeout(120_000);

  function getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders![0].uri.fsPath;
  }

  function nonRslintDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
    return vscode.languages
      .getDiagnostics(uri)
      .filter((diagnostic) => diagnostic.source !== 'rslint');
  }

  async function waitForNonRslintDiagnostics(
    uri: vscode.Uri,
    predicate: (diagnostics: vscode.Diagnostic[]) => boolean,
    timeoutMs = 60_000,
  ): Promise<vscode.Diagnostic[]> {
    const deadline = Date.now() + timeoutMs;
    let diagnostics = nonRslintDiagnostics(uri);
    while (!predicate(diagnostics)) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for TypeScript diagnostics on ${uri.toString()}. ` +
            `Last diagnostics: ${diagnostics.map((d) => `${d.source ?? '<no source>'}: ${d.message}`).join(' | ') || '<none>'}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      diagnostics = nonRslintDiagnostics(uri);
    }
    return diagnostics;
  }

  test('a valid typed rule option actually configures the rule at lint time', async () => {
    const filePath = path.join(getWorkspaceRoot(), 'src', 'index.ts');
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    const diagnostics = await waitForRslintDiagnostics(doc, (diags) =>
      diags.some((d) => d.message.includes('Unexpected console statement')),
    );

    const consoleLogLine = doc.lineAt(0);
    const consoleWarnLine = doc.lineAt(1);
    assert.ok(
      diagnostics.some(
        (d) =>
          d.message.includes('Unexpected console statement') &&
          d.range.start.line === consoleLogLine.lineNumber,
      ),
      'console.log must be reported: `allow` only lists "warn"',
    );
    assert.ok(
      !diagnostics.some(
        (d) =>
          d.message.includes('Unexpected console statement') &&
          d.range.start.line === consoleWarnLine.lineNumber,
      ),
      'console.warn must NOT be reported: it is in the configured `allow` list',
    );
  });

  test('an invalid typed rule option is rejected by TypeScript in the config file', async () => {
    const configPath = path.join(getWorkspaceRoot(), 'rslint.config.ts');
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);

    // `tsReadySentinel` at the bottom of the fixture is an unconditional,
    // unsuppressed type error — wait for it specifically rather than for
    // "any diagnostic", since the intentional error under test is expected
    // to be swallowed by `@ts-expect-error` and would otherwise never make
    // diagnostics non-empty.
    const diagnostics = await waitForNonRslintDiagnostics(doc.uri, (diags) =>
      diags.some((d) =>
        String(d.message).includes("not assignable to type 'string'"),
      ),
    );

    assert.ok(
      !diagnostics.some((d) =>
        String(d.message).includes('Cannot find module'),
      ),
      `'@rslint/core' must resolve so its published types are actually in effect. Diagnostics: ${diagnostics.map((d) => d.message).join(' | ')}`,
    );
    // Every `@ts-expect-error` in the fixture marks an option value that the
    // rule's JSON Schema rejects, so each one must be triggered. An unused one
    // means that rule's generated type stopped constraining its options —
    // typically because `RulesRecord` references a type name that no
    // declaration in the emitted `.d.ts` actually defines, which silently
    // degrades the options to `any`.
    const unusedExpectErrorLines = diagnostics
      .filter((d) => String(d.message).includes("Unused '@ts-expect-error'"))
      .map((d) => d.range.start.line + 1);
    assert.deepStrictEqual(
      unusedExpectErrorLines,
      [],
      'generated rule-option types stopped constraining options for the rule(s) ' +
        `configured at rslint.config.ts line(s) ${unusedExpectErrorLines.join(', ')}`,
    );
  });
});
