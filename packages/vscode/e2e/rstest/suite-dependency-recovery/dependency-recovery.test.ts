import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import vscode from 'vscode';
import type { RstackExtensionExports } from '../../../src/types';
import { getProjectItems, getRstestExports, waitFor } from '../suite/helpers';

const execFile = promisify(execFileCallback);

suite('Rstest dependency polling recovery', function () {
  this.timeout(180_000);

  test('recovers after pnpm install without a restart command', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    const root = folder.uri.fsPath;
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
    const extension =
      vscode.extensions.getExtension<RstackExtensionExports>('rstack.rstack');
    assert.ok(extension);
    const api = await extension.activate();
    api.setDependencyPollIntervalForTest(250);
    const rstest = await getRstestExports();
    const hasNotInstalled = api.getStackExports('rstest')
      ?.hasNotInstalledState as () => boolean;
    await waitFor(() => assert.equal(hasNotInstalled(), true));

    const lockfile = path.join(root, 'pnpm-lock.yaml');
    const contents = fs.readFileSync(lockfile);
    const mtime = fs.statSync(lockfile).mtimeMs;
    const polls = api.getDependencyPollCountForTest();
    await execFile(
      'pnpm',
      ['install', '--frozen-lockfile', '--ignore-scripts'],
      {
        cwd: root,
        timeout: 90_000,
        // Windows needs a shell for pnpm.cmd; arguments are fixed safe tokens.
        shell: process.platform === 'win32',
      },
    );
    assert.deepEqual(
      fs.readFileSync(lockfile),
      contents,
      'lockfile contents changed',
    );
    assert.equal(
      fs.statSync(lockfile).mtimeMs,
      mtime,
      'lockfile mtime changed',
    );

    await waitFor(
      () => {
        assert.equal(hasNotInstalled(), false);
        const items = getProjectItems(rstest.testController);
        assert.ok(items.some((item) => item.id.endsWith('/test/foo.test.ts')));
        assert.ok(api.getDependencyPollCountForTest() > polls);
      },
      { timeoutMs: 90_000, pollMs: 100 },
    );
  });
});
