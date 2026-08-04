// Ported from upstream `rstest/packages/vscode/tests/suite/uxCommands.test.ts`.
//
// Adaptations: command ids are `rstack.rstest.*` (unified namespace),
// and upstream's `rstest.openOutput` no longer exists — the
// shell owns the four output channels and registers
// `rstack.rstest.output.focus` instead, which is what is exercised here.
// The command behaviors asserted (clipboard contents, reveal, terminal
// creation named "Rstest") are upstream's, unchanged.
import assert from 'node:assert';
import vscode from 'vscode';
import { getRstestExports, getTestItemByLabels, waitFor } from './helpers';

suite('Editor / Test Explorer UX commands', () => {
  test('openOutput, copyErrorOutput, revealInTestExplorer, copyTestItemErrors', async () => {
    const rstestInstance = await getRstestExports();
    const controller = rstestInstance.testController;
    assert.ok(controller, 'Test controller should be exported');

    // Focusing the output channel just reveals it — it must not throw.
    // (Upstream: `rstest.openOutput`; here the shell-owned equivalent.)
    await vscode.commands.executeCommand('rstack.rstest.output.focus');

    const fileItem = await waitFor(() =>
      getTestItemByLabels(controller.items, ['test', 'progress.test.ts']),
    );

    // copyErrorOutput copies the given message's text to the clipboard.
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('rstack.rstest.copyErrorOutput', {
      test: fileItem,
      message: new vscode.TestMessage('copied error text'),
    });
    assert.strictEqual(
      await vscode.env.clipboard.readText(),
      'copied error text',
    );

    // revealInTestExplorer delegates to the built-in reveal command; this
    // fails loudly if the command id or argument shape is wrong.
    assert.ok(fileItem.uri, 'test file item should have a uri');
    await vscode.commands.executeCommand(
      'rstack.rstest.revealInTestExplorer',
      fileItem.uri,
    );

    // Run the failing fixture so the error store is populated, then copy the
    // file item's aggregated errors.
    await rstestInstance.startTestRun(
      new vscode.TestRunRequest(
        [fileItem],
        undefined,
        rstestInstance.runProfile,
      ),
      new vscode.CancellationTokenSource().token,
      false,
    );

    await vscode.commands.executeCommand(
      'rstack.rstest.copyTestItemErrors',
      fileItem,
    );
    assert.match(
      await vscode.env.clipboard.readText(),
      /expected 1 to equal 2/,
    );

    // runInTerminal builds the real rstest command and opens a shell terminal;
    // it must resolve the CLI and not throw.
    await vscode.commands.executeCommand(
      'rstack.rstest.runInTerminal',
      fileItem,
    );
    const terminal = await waitFor(() =>
      vscode.window.terminals.find((candidate) => candidate.name === 'Rstest'),
    );
    assert.ok(terminal, 'a Rstest terminal should be created');
    terminal.dispose();
  });
});
