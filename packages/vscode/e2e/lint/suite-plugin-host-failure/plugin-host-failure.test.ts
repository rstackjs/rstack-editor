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

  test('disables failed plugins while native diagnostics remain and recovers without restart', async () => {
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
    const disabled = await waitForState('disabled');
    assert.ok(disabled.kind === 'disabled');
    assert.ok(disabled.reason);
    assert.match(
      disabled.reason,
      /^ESLint plugins failed to load: .*fixture plugin import exploded/,
    );
    assert.ok(!disabled.reason.includes('\n'));
    const warnings = api.getRecordedWarnings('rslint');
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /^\[[^\]]+\] ESLint plugins failed to load: .*fixture plugin import exploded$/,
    );
    await waitForRslintDiagnostics(document, (diagnostics) =>
      diagnostics.some((d) => diagnosticRuleIdIncludes(d, 'no-console')),
    );

    api.setDependencyPollIntervalForTest(250);
    try {
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
