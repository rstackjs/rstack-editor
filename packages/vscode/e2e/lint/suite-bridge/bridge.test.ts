import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  getRslintDiagnostics,
  waitForRslintDiagnostics,
  waitForRslintDiagnosticsCount,
} from '../utils/diagnostics';

const nativeConfigName = 'rslint.config.mjs';

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('VS Code test workspace is unavailable');
  return folder.uri.fsPath;
}

function configSource(rule: 'error' | 'off', markerPath?: string): string {
  const marker =
    markerPath === undefined
      ? ''
      : `import { writeFileSync } from 'node:fs';\n\n`;
  const callbackStart =
    markerPath === undefined
      ? 'define.lint(['
      : `define.lint(() => {\n  writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ pid: process.pid, execPath: process.execPath }));\n  return [`;
  const callbackEnd = markerPath === undefined ? ']);' : '  ];\n});';
  return `${marker}import { define } from 'rstack';

${callbackStart}
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-debugger': '${rule}',
    },
  },
${callbackEnd}
`;
}

async function openLintTarget(): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(
    path.join(workspaceRoot(), 'src', 'index.ts'),
  );
  await vscode.window.showTextDocument(document);
  return document;
}

function hasNoDebugger(diagnostics: readonly vscode.Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) =>
    diagnostic.message.includes('no-debugger'),
  );
}

suite('Rstack lint bridge', function () {
  this.timeout(120_000);

  const root = workspaceRoot();
  const rstackConfigPath = path.join(root, 'rstack.config.ts');
  const nativeConfigPath = path.join(root, nativeConfigName);
  const markerPath = path.join(root, '.lint-worker-config.json');
  const originalConfig = fs.readFileSync(rstackConfigPath, 'utf8');

  teardown(async () => {
    fs.writeFileSync(rstackConfigPath, originalConfig, 'utf8');
    fs.rmSync(nativeConfigPath, { force: true });
    fs.rmSync(markerPath, { force: true });
    const document = vscode.workspace.textDocuments.find(
      (candidate) =>
        candidate.uri.fsPath === path.join(root, 'src', 'index.ts'),
    );
    if (document) {
      await waitForRslintDiagnostics(document, hasNoDebugger);
    }
  });

  test('matches rs lint and evaluates define.lint outside the extension host', async () => {
    const document = await openLintTarget();
    const diagnostics = await waitForRslintDiagnostics(document, hasNoDebugger);
    assert.ok(
      hasNoDebugger(diagnostics),
      `Expected the bridged no-debugger diagnostic, got: ${diagnostics
        .map((diagnostic) => diagnostic.message)
        .join(' | ')}`,
    );

    const rsBin = path.join(
      path.dirname(root),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'rs.cmd' : 'rs',
    );
    const cli = spawnSync(rsBin, ['lint'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    assert.equal(cli.error, undefined, `rs lint failed to start: ${cli.error}`);
    assert.match(
      `${cli.stdout}${cli.stderr}`,
      /no-debugger/,
      'rs lint should report the same configured rule as the editor',
    );

    fs.writeFileSync(
      rstackConfigPath,
      configSource('error', markerPath),
      'utf8',
    );
    await waitForRslintDiagnostics(document, () => fs.existsSync(markerPath));
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as {
      pid: number;
      execPath: string;
    };
    assert.notEqual(
      marker.pid,
      process.pid,
      `define.lint ran in the extension host (${marker.execPath})`,
    );
    assert.notEqual(
      marker.execPath,
      process.execPath,
      `define.lint ran on the VS Code Node runtime (${marker.execPath})`,
    );
  });

  test('refreshes diagnostics when rstack.config.ts changes', async () => {
    const document = await openLintTarget();
    await waitForRslintDiagnostics(document, hasNoDebugger);

    fs.writeFileSync(rstackConfigPath, configSource('off'), 'utf8');
    const diagnostics = await waitForRslintDiagnosticsCount(document, 0);
    assert.deepStrictEqual(diagnostics, []);

    fs.writeFileSync(rstackConfigPath, originalConfig, 'utf8');
    await waitForRslintDiagnostics(document, hasNoDebugger);
  });

  test('replaces bridged ownership when a native config appears', async () => {
    const document = await openLintTarget();
    await waitForRslintDiagnostics(document, hasNoDebugger);

    fs.writeFileSync(
      nativeConfigPath,
      `export default [{ rules: { 'no-debugger': 'off' } }];\n`,
      'utf8',
    );
    await waitForRslintDiagnosticsCount(document, 0);
    assert.deepStrictEqual(getRslintDiagnostics(document), []);

    fs.rmSync(nativeConfigPath);
    await waitForRslintDiagnostics(document, hasNoDebugger);
  });
});
