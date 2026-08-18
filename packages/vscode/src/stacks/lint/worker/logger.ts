import type { Logger as JsonRpcLogger } from 'vscode-jsonrpc/node';

const format = (value: unknown): string => {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export class WorkerLogger implements JsonRpcLogger {
  private write(level: string, message: string, error?: unknown): void {
    const detail = error === undefined ? '' : `\n${format(error)}`;
    process.stderr.write(`[rslint-worker:${level}] ${message}${detail}\n`);
  }

  debug(message: string, error?: unknown): void {
    this.write('debug', message, error);
  }

  error(message: string, error?: unknown): void {
    this.write('error', message, error);
  }

  info(message: string, error?: unknown): void {
    this.write('info', message, error);
  }

  log(message: string): void {
    this.write('log', message);
  }

  warn(message: string, error?: unknown): void {
    this.write('warn', message, error);
  }
}

export const logger = new WorkerLogger();
