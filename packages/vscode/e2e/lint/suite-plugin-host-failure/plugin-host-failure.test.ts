import * as assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { StackState } from '../../../src/types';
import { extensionExports } from '../utils/extension';
import {
  diagnosticRuleIdIncludes,
  waitForRslintDiagnostics,
} from '../utils/diagnostics';

suite('Plugin-host status and polling recovery', function () {
  this.timeout(120_000);

  test('keeps native diagnostics during plugin failure, classifies missing imports, and recovers without restart', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root);
    const api = extensionExports();
    const lint = api.getStackExports('rslint') as {
      getFolderStates(): ReadonlyMap<string, StackState>;
    };
    assert.ok(lint);
    const waitForState = async (kind: StackState['kind']) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const state = [...lint.getFolderStates().values()].find(
          (state) => state.kind === kind,
        );
        if (state) return state;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `Expected ${kind}; got ${JSON.stringify([...lint.getFolderStates().values()])}`,
      );
    };
    const document = await vscode.workspace.openTextDocument(
      path.join(root, 'src/index.ts'),
    );
    await vscode.window.showTextDocument(document);
    const crashed = await waitForState('crashed');
    if (crashed.kind === 'crashed') {
      assert.match(
        crashed.detail,
        /^ESLint plugins failed to load: .*fixture plugin import exploded/,
      );
      assert.ok(!crashed.detail.includes('\n'));
    }
    await waitForRslintDiagnostics(document, (diagnostics) =>
      diagnostics.some((d) => diagnosticRuleIdIncludes(d, 'no-console')),
    );

    api.setDependencyPollIntervalForTest(250);
    try {
      fs.writeFileSync(path.join(root, 'host-state.txt'), 'missing');
      const disabled = await waitForState('disabled');
      if (disabled.kind === 'disabled') {
        assert.ok(disabled.reason);
        assert.match(disabled.reason, /install the project dependencies/);
      }
      const deadline = Date.now() + 60_000;
      while (
        fs
          .readFileSync(path.join(root, 'attempts.log'), 'utf8')
          .split('\n')
          .filter((line) => line === 'missing').length < 2
      ) {
        assert.ok(Date.now() < deadline, 'Expected a second plugin-host retry');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const warnings = api.getRecordedWarnings('rslint');
      assert.equal(
        warnings.length,
        1,
        'Retries must not repeat the missing-package warning',
      );
      assert.match(warnings[0], /rstack-e2e-absent-plugin-dependency/);
      assert.ok(
        !warnings[0].includes('\n'),
        'Missing-package warning must be one line',
      );

      fs.writeFileSync(path.join(root, 'host-state.txt'), 'ready');
      await waitForState('running');
      await waitForRslintDiagnostics(document, (diagnostics) =>
        ['local/report', 'no-console'].every((rule) =>
          diagnostics.some((d) => diagnosticRuleIdIncludes(d, rule)),
        ),
      );
    } finally {
      api.setDependencyPollIntervalForTest(60_000);
    }
  });
});
