import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { RstackExtensionExports } from '../../src/types';
import { eventually } from './helpers';

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
      'rstack.showOutput',
      'rstack.restart',
      'rstack.rslint.output.focus',
      'rstack.rslint.restart',
      'rstack.rstest.output.focus',
      'rstack.rstest.restart',
      'rstack.fmt.output.focus',
      'rstack.fmt.restart',
    ]) {
      assert.ok(commands.includes(command), `missing command ${command}`);
    }
  });

  test('has a status bar item whose click target works', async () => {
    // VS Code exposes no API to enumerate another extension's status bar items,
    // so the item itself cannot be asserted on directly. What *is* observable
    // is its command: the item is created with `command = 'rstack.showOutput'`
    // and shown unconditionally, so a `showOutput` that reveals the channel
    // without throwing is the strongest available evidence that the
    // always-present status bar item exists and is wired up.
    await vscode.commands.executeCommand('rstack.showOutput');
  });

  test('rebuilds the live stacks on rstack.restart', async () => {
    // The restart is a full reset: every controller is disposed and rebuilt,
    // so the exports a stack publishes at registration must be a *different*
    // object afterwards. That is the only externally visible proof that the
    // stack was rebuilt rather than left alone (`reconcileStack` returns early
    // for a stack that is already registered).
    const extension =
      vscode.extensions.getExtension<RstackExtensionExports>(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
    const api = await extension.activate();

    const before = await api.whenStackActive('rstest');

    // The command resolves only once the whole restart is done, so no polling
    // is needed to observe the result.
    await vscode.commands.executeCommand('rstack.restart');

    const after = api.getStackExports('rstest');
    assert.ok(after, 'the Rstest stack did not come back after the restart');
    assert.notEqual(
      after,
      before,
      'the restart must rebuild the controller, not keep the old one',
    );
  });

  test('opens the three fixture folders', () => {
    const names = (vscode.workspace.workspaceFolders ?? []).map(
      (folder) => folder.name,
    );
    assert.deepEqual(names.slice().sort(), ['rslint', 'rstack', 'rstest']);
  });
});
