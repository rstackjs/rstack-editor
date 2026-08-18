import vscode from 'vscode';
import { type StackId, STACK_IDS } from './types';

const CHANNEL_NAMES: Readonly<Record<StackId | 'shell', string>> = {
  shell: 'Rstack',
  rslint: 'Rstack: Rslint',
  rstest: 'Rstack: Rstest',
  fmt: 'Rstack: rs fmt',
};

/**
 * The extension's four output channels — a deliberate cap: one per stack plus
 * one for the shell (detection results, state transitions).
 *
 * Stacks never create their own channel — a copied stack that used to create
 * one per workspace folder has to log into the shared channel instead.
 */
export class Channels implements vscode.Disposable {
  readonly shell: vscode.LogOutputChannel;

  readonly #stacks: Record<StackId, vscode.LogOutputChannel>;

  constructor() {
    this.shell = vscode.window.createOutputChannel(CHANNEL_NAMES.shell, {
      log: true,
    });
    this.#stacks = Object.fromEntries(
      STACK_IDS.map((stack) => [
        stack,
        vscode.window.createOutputChannel(CHANNEL_NAMES[stack], { log: true }),
      ]),
    ) as Record<StackId, vscode.LogOutputChannel>;
  }

  forStack(stack: StackId): vscode.LogOutputChannel {
    return this.#stacks[stack];
  }

  dispose(): void {
    this.shell.dispose();
    for (const stack of STACK_IDS) {
      this.#stacks[stack].dispose();
    }
  }
}
