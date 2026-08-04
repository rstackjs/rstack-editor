import type vscode from 'vscode';
import { BaseLogger, type LogLevel } from './shared/logger';

/**
 * The status-aggregation adaptation: the stack no longer owns an output channel.
 * The shell creates the four channels and hands this stack its own one, so
 * `MasterLogger` writes into a channel it does not own and must never dispose.
 *
 * The binding is a module singleton because every upstream module imports the
 * `logger` singleton directly; keeping that shape is what makes the copied
 * files diffable against `web-infra-dev/rstest`. `bind()` is called once per
 * `register()` and `unbind()` on `dispose()`, so a re-registered stack (a gate
 * flip, a trust grant) logs into the fresh channel and a disposed stack logs
 * nowhere instead of throwing on a disposed channel.
 */
class MasterLogger extends BaseLogger {
  #channel: vscode.LogOutputChannel | undefined;

  protected override log(level: LogLevel, message: string) {
    this.#channel?.[level](message);
  }

  public bind(channel: vscode.LogOutputChannel) {
    this.#channel = channel;
  }

  public unbind() {
    this.#channel = undefined;
  }

  public show() {
    this.#channel?.show();
  }
}

export const logger = new MasterLogger();
