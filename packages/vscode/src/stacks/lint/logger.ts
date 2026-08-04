// Replaces web-infra-dev/rslint `packages/vscode-extension/src/logger.ts`.
//
// Upstream's `Logger` creates one `OutputChannel` per instance — one per
// workspace folder plus one for the extension. This extension deliberately
// caps itself at four channels, so this adapter keeps the upstream call surface
// (`debug`/`info`/`warn`/`error`, `WorkspaceCoordinatorLogger`-compatible) but
// writes into the shell-owned `Rstack: Rslint` channel with a per-folder
// prefix. `dispose()` is deliberately a no-op: the channel outlives the stack.

import type { LogOutputChannel } from 'vscode';

const formatArg = (arg: unknown): string => {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg instanceof Error) {
    return `\n${arg.stack ?? arg.message}`;
  }
  try {
    return JSON.stringify(arg, null, 2) ?? String(arg);
  } catch {
    return String(arg);
  }
};

const formatMessage = (message: string, args: unknown[]): string =>
  args.length === 0 ? message : `${message} ${args.map(formatArg).join(' ')}`;

/**
 * A prefixing view over the shared Rslint output channel.
 *
 * Log-level filtering is delegated to VS Code (`LogOutputChannel` honors the
 * user's per-channel log level), which replaces upstream's `LogLevel` enum and
 * `Logger.setDefaultLogLevel(context)` development-mode switch.
 */
export class Logger {
  readonly #channel: LogOutputChannel;
  readonly #prefix: string;

  constructor(channel: LogOutputChannel, scope?: string) {
    this.#channel = channel;
    this.#prefix = scope ? `[${scope}] ` : '';
  }

  /** Derives a logger for one workspace folder from the stack-wide one. */
  forScope(scope: string): Logger {
    return new Logger(this.#channel, scope);
  }

  trace(message: string, ...args: unknown[]): void {
    this.#channel.trace(`${this.#prefix}${formatMessage(message, args)}`);
  }

  debug(message: string, ...args: unknown[]): void {
    this.#channel.debug(`${this.#prefix}${formatMessage(message, args)}`);
  }

  info(message: string, ...args: unknown[]): void {
    this.#channel.info(`${this.#prefix}${formatMessage(message, args)}`);
  }

  warn(message: string, ...args: unknown[]): void {
    this.#channel.warn(`${this.#prefix}${formatMessage(message, args)}`);
  }

  error(message: string, error?: unknown, ...args: unknown[]): void {
    if (error instanceof Error) {
      this.#channel.error(
        error,
        `${this.#prefix}${formatMessage(message, args)}`,
      );
      return;
    }
    const detail = error === undefined ? args : [error, ...args];
    this.#channel.error(`${this.#prefix}${formatMessage(message, detail)}`);
  }

  show(): void {
    this.#channel.show();
  }

  /** No-op: the output channel is owned by the extension shell. */
  dispose(): void {}
}
