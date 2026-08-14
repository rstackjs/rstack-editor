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
// A CI-only worker failure is otherwise undiagnosable: worker stdout and
// stderr land only in the output channel, which CI cannot open. The E2E
// harness sets this flag in CI (via `extensionTestsEnv`, so it is fixed at
// host launch) and the logger mirrors every entry to the extension host's
// stderr. It must be `console.error` for every level: CI forwards only the
// extension host's stderr, not its stdout (see `e2e/rstest/suite/index.ts`),
// so `console[level]` would silently drop everything below `error`.
const mirrorToConsole = process.env.RSTACK_E2E_MIRROR_LOGS === '1';

class MasterLogger extends BaseLogger {
  #channel: vscode.LogOutputChannel | undefined;

  protected override log(level: LogLevel, message: string) {
    this.#channel?.[level](message);
    if (mirrorToConsole) {
      console.error(`[rstest ${level}] ${message}`);
    }
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
