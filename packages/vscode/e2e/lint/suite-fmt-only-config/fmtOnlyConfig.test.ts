import * as assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { StackState } from '../../../src/types';
import {
  diagnosticRuleIdIncludes,
  getRslintDiagnostics,
  waitForRslintDiagnostics,
} from '../utils/diagnostics';
import { extensionExports } from '../utils/extension';

// rstack's lint shim calls `process.exit(1)` when the Rstack config has no
// `define.lint()` (#93). The root config still lights the lint stack, so the
// bridged runtime must survive the shim's refusal and report `not-detected`
// with the reason (the status bar's word for "no configuration here"), then
// pick up `define.lint()` through its config watcher in the same worker.

function lintExports(): {
  getFolderStates(): ReadonlyMap<string, StackState>;
  getRuntimeStates(): ReadonlyMap<string, StackState>;
} {
  const exports = extensionExports().getStackExports('rslint');
  assert.ok(exports, 'lint stack exports are unavailable');
  return exports as ReturnType<typeof lintExports>;
}

function lintStates(): StackState[] {
  const exports = lintExports();
  return [
    ...exports.getFolderStates().values(),
    ...exports.getRuntimeStates().values(),
  ];
}

function isUnconfigured(state: StackState): boolean {
  return (
    state.kind === 'not-detected' &&
    state.detail !== undefined &&
    state.detail.includes('define.lint()')
  );
}

function hasNoDebugger(diagnostics: readonly vscode.Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) =>
    diagnosticRuleIdIncludes(diagnostic, 'no-debugger'),
  );
}

/** Polls `condition`, failing as soon as any lint state is `crashed`. */
async function waitForLintStates(
  description: string,
  condition: (states: StackState[]) => boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = lintStates();
    const crashed = states.find((state) => state.kind === 'crashed');
    assert.equal(
      crashed,
      undefined,
      `Rslint became crashed while waiting for ${description}: ${crashed?.kind === 'crashed' ? crashed.detail : ''}`,
    );
    if (states.length > 0 && condition(states)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('VS Code test workspace is unavailable');
  return folder.uri.fsPath;
}

function configSource(markerPath: string, lint: boolean): string {
  const lintBlock = lint
    ? `
define.lint([
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-debugger': 'error',
    },
  },
]);
`
    : '';
  return `import { writeFileSync } from 'node:fs';
import { define } from 'rstack';

// The fmt server and the Rstest worker evaluate this file too; only the lint
// worker records itself. The name is the worker bundle's (\`rslib.config.mts\`).
if (process.argv[1]?.endsWith('lint-worker.js')) {
  writeFileSync(${JSON.stringify(markerPath)}, String(process.pid));
}

define.fmt({ singleQuote: true });
${lintBlock}`;
}

suite('Rstack fmt-only config', function () {
  this.timeout(180_000);

  const root = workspaceRoot();
  const configPath = path.join(root, 'rstack.config.ts');
  const markerPath = path.join(root, '.lint-worker-pid');
  const originalConfig = fs.readFileSync(configPath, 'utf8');

  teardown(() => {
    fs.writeFileSync(configPath, originalConfig, 'utf8');
    fs.rmSync(markerPath, { force: true });
  });

  test('a formatting-only config reports not-detected and recovers on define.lint()', async () => {
    // Still formatting-only; the lint runtime starts on `didOpen`, so the
    // first shim evaluation records the lint worker's pid.
    fs.writeFileSync(configPath, configSource(markerPath, false), 'utf8');
    const document = await vscode.workspace.openTextDocument(
      path.join(root, 'src', 'index.ts'),
    );
    await vscode.window.showTextDocument(document);

    // Bare `running` appears before the initial config refresh settles; the
    // folder and its runtime must both show the classified refusal.
    await waitForLintStates('the unconfigured not-detected detail', (states) =>
      states.every(isUnconfigured),
    );
    assert.ok(fs.existsSync(markerPath), 'the lint worker never ran the shim');
    const workerPid = fs.readFileSync(markerPath, 'utf8');
    assert.deepStrictEqual(getRslintDiagnostics(document), []);

    fs.writeFileSync(configPath, configSource(markerPath, true), 'utf8');
    const diagnostics = await waitForRslintDiagnostics(document, hasNoDebugger);
    assert.ok(hasNoDebugger(diagnostics));
    await waitForLintStates('the plain running state', (states) =>
      states.every(
        (state) => state.kind === 'running' && !isUnconfigured(state),
      ),
    );
    // Any worker restart in between would have changed the pid.
    assert.strictEqual(
      fs.readFileSync(markerPath, 'utf8'),
      workerPid,
      'define.lint() must be picked up by the same lint worker, without a restart',
    );
    // Not a failure: logged at info, so no warning was recorded.
    assert.deepStrictEqual(
      extensionExports().getRecordedWarnings('rslint'),
      [],
    );
  });
});
