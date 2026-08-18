import path from 'node:path';

export interface LintWorkerOptions {
  readonly coreDir: string;
  readonly configPath?: string;
}

export interface ConfigRefreshParams {
  readonly reason: unknown;
}

export const LINT_WORKER_USAGE =
  'Usage: lint-worker --lsp --core <absolute @rslint/core dir> [--config <absolute module>]';

export function parseWorkerArgs(args: readonly string[]): LintWorkerOptions {
  if (args.length !== 3 && args.length !== 5) {
    throw new Error(LINT_WORKER_USAGE);
  }
  if (args[0] !== '--lsp' || args[1] !== '--core') {
    throw new Error(LINT_WORKER_USAGE);
  }
  const coreDir = args[2];
  if (!coreDir || !path.isAbsolute(coreDir)) {
    throw new Error(`--core must be an absolute path\n${LINT_WORKER_USAGE}`);
  }
  if (args.length === 3) return { coreDir: path.normalize(coreDir) };
  if (args[3] !== '--config') {
    throw new Error(LINT_WORKER_USAGE);
  }
  const configPath = args[4];
  if (!configPath || !path.isAbsolute(configPath)) {
    throw new Error(`--config must be an absolute path\n${LINT_WORKER_USAGE}`);
  }
  return {
    coreDir: path.normalize(coreDir),
    configPath: path.normalize(configPath),
  };
}

export function stampConfigRefresh(
  params: ConfigRefreshParams,
  protocolVersion: number,
  configPath?: string,
): Record<string, unknown> {
  return {
    protocolVersion,
    reason: params?.reason,
    ...(configPath === undefined ? {} : { configPath }),
  };
}
