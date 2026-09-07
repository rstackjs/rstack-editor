export const CONFIG_DEPENDENCY_STATUS_NOTIFICATION =
  'rstack/rslintConfigDependency';

export interface ConfigDependencyFailure {
  readonly configPath: string;
  readonly cause: string;
}

export interface ConfigDependencyStatusNotification {
  readonly failure: ConfigDependencyFailure | null;
  /** Present only when refresh rejected without a classified dependency cause. */
  readonly error?: string;
}

/** Shared with the editor's startup retry; this module stays vscode-free. */
export function isConfigSourceChangeDuringTransaction(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || Array.isArray(error))
    return false;
  const value = error as Record<string, unknown>;
  return (
    value.code === 'CONFIG_CHANGED_DURING_LOAD' ||
    (typeof value.message === 'string' &&
      value.message.includes('config changed while'))
  );
}
