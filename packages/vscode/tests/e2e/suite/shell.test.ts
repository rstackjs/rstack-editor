import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { delay, eventually } from './helpers';

const EXTENSION_ID = 'rstack.rstack';

/**
 * The shell always activates on `onStartupFinished` and does
 * exactly three things — create the status bar item, run detection, register the
 * stacks that pass the gate.
 */
suite('shell', () => {
  test('activates on startup without being asked to', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);

    assert.deepEqual(
      extension.packageJSON.activationEvents,
      ['onStartupFinished'],
      'the shell must have exactly one activation event',
    );

    // Deliberately no `extension.activate()`: activating it here would prove
    // nothing about `onStartupFinished`. The suite starts right after the
    // window is up, so the event may still be in flight — hence the poll.
    await eventually(() => {
      assert.equal(extension.isActive, true, 'extension is not active yet');
    }, 'the extension to activate itself');
  });

  test('registers the shell commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'rstack.showMenu',
      'rstack.showOutput',
      'rstack.migrateSettings',
      'rstack.rslint.output.focus',
      'rstack.rstest.output.focus',
      'rstack.fmt.output.focus',
    ]) {
      assert.ok(commands.includes(command), `missing command ${command}`);
    }
  });

  test('has a status bar item whose menu opens', async () => {
    // VS Code exposes no API to enumerate another extension's status bar items,
    // so the item itself cannot be asserted on directly. What *is* observable
    // is its command: the item is created with `command = 'rstack.showMenu'`
    // and shown unconditionally, so a `showMenu` that opens a QuickPick without
    // throwing is the strongest available evidence that the always-present
    // status bar item exists and is wired up.
    let failure: unknown;
    const menu = Promise.resolve(
      vscode.commands.executeCommand('rstack.showMenu'),
    ).catch((error: unknown) => {
      failure = error;
    });

    await delay(1_000);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await Promise.race([menu, delay(5_000)]);

    assert.equal(
      failure,
      undefined,
      `rstack.showMenu failed: ${String(failure)}`,
    );
  });

  test('opens the three fixture folders', () => {
    const names = (vscode.workspace.workspaceFolders ?? []).map(
      (folder) => folder.name,
    );
    assert.deepEqual(names.slice().sort(), ['rslint', 'rstack', 'rstest']);
  });
});
