import * as assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { StackState } from '../../../src/types';
import {
  getRslintDiagnostics,
  waitForRslintDiagnostics,
} from '../utils/diagnostics';
import { extensionExports } from '../utils/extension';

function lintExports(): {
  getFolderStates(): ReadonlyMap<string, StackState>;
  getRuntimeStates(): ReadonlyMap<string, StackState>;
  getConfigDependencyWarnings(): readonly string[];
} {
  const exports = extensionExports().getStackExports('rslint');
  assert.ok(exports, 'lint stack exports are unavailable');
  return exports as ReturnType<typeof lintExports>;
}

async function waitForRuntimeKind(
  kind: StackState['kind'],
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exports = lintExports();
    const states = [
      ...exports.getFolderStates().values(),
      ...exports.getRuntimeStates().values(),
    ];
    const crashed = states.find((state) => state.kind === 'crashed');
    assert.equal(
      crashed,
      undefined,
      `Rslint became crashed while waiting for ${kind}: ${crashed?.detail}`,
    );
    if (states.some((state) => state.kind === kind)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the Rslint runtime to become ${kind}`);
}

suite('Rslint missing config dependency', function () {
  this.timeout(120_000);

  test('reports not installed across initial and live config refreshes', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root, 'VS Code test workspace is unavailable');
    const document = await vscode.workspace.openTextDocument(
      path.join(root, 'src', 'index.ts'),
    );
    await vscode.window.showTextDocument(document);

    await waitForRuntimeKind('disabled');

    const folderStates = [...lintExports().getFolderStates().values()];
    const runtimeStates = [...lintExports().getRuntimeStates().values()];
    assert.ok(folderStates.every((state) => state.kind === 'disabled'));
    assert.ok(runtimeStates.every((state) => state.kind === 'disabled'));
    assert.deepStrictEqual(getRslintDiagnostics(document), []);

    const warnings = lintExports().getConfigDependencyWarnings();
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /missing-rslint-config-dependency/);
    assert.ok(!warnings[0].includes('\n'), 'warning must remain one line');

    const configPath = path.join(root, 'rslint.config.mjs');
    fs.writeFileSync(
      configPath,
      "export default [{ files: ['src/**/*.ts'], rules: { 'no-debugger': 'error' } }];\n",
    );
    await waitForRslintDiagnostics(document);
    await waitForRuntimeKind('running');

    fs.writeFileSync(
      configPath,
      "import 'missing-rslint-config-dependency';\nexport default [];\n",
    );
    await waitForRuntimeKind('disabled');
    assert.strictEqual(
      lintExports().getConfigDependencyWarnings().length,
      warnings.length + 1,
      'the new missing-dependency episode must add exactly one warning',
    );
  });
});
