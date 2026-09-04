import * as assert from 'node:assert';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { StackState } from '../../../src/types';
import { waitForRslintDiagnostics } from '../utils/diagnostics';
import { extensionExports } from '../utils/extension';

const execFile = promisify(execFileCallback);

function lintExports(): {
  getFolderStates(): ReadonlyMap<string, StackState>;
} {
  const exports = extensionExports().getStackExports('rslint');
  assert.ok(exports, 'lint stack exports are unavailable');
  return exports as ReturnType<typeof lintExports>;
}

async function waitForFolderKind(
  kind: StackState['kind'],
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      [...lintExports().getFolderStates().values()].some(
        (state) => state.kind === kind,
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the Rslint folder to become ${kind}`);
}

suite('Rslint dependency polling recovery', function () {
  this.timeout(180_000);

  test('recovers after pnpm install without a restart command', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root, 'VS Code test workspace is unavailable');
    const api = extensionExports();
    api.setDependencyPollIntervalForTest(250);

    const document = await vscode.workspace.openTextDocument(
      path.join(root, 'src', 'index.ts'),
    );
    await vscode.window.showTextDocument(document);
    await waitForFolderKind('disabled');

    const lockfile = path.join(root, 'pnpm-lock.yaml');
    const beforeContents = fs.readFileSync(lockfile);
    const beforeMtime = fs.statSync(lockfile).mtimeMs;
    const pollCountBeforeInstall = api.getDependencyPollCountForTest();

    await execFile(
      'pnpm',
      ['install', '--frozen-lockfile', '--ignore-scripts'],
      { cwd: root, timeout: 90_000 },
    );

    assert.deepStrictEqual(
      fs.readFileSync(lockfile),
      beforeContents,
      'pnpm install changed the lockfile contents',
    );
    assert.strictEqual(
      fs.statSync(lockfile).mtimeMs,
      beforeMtime,
      'pnpm install changed the lockfile mtime',
    );

    await waitForRslintDiagnostics(document, undefined, 90_000);
    await waitForFolderKind('running');
    assert.ok(
      api.getDependencyPollCountForTest() > pollCountBeforeInstall,
      'the folder recovered without a dependency polling pass',
    );
  });
});
