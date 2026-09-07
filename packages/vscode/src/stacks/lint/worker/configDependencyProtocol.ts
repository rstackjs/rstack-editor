import type { ConfigDependencyFailure } from '../../../shared/notInstalled';

export const CONFIG_DEPENDENCY_STATUS_NOTIFICATION =
  'rstack/rslintConfigDependency';

export type ConfigDependencyStatusNotification =
  | { readonly kind: 'ok' }
  | { readonly kind: 'missing'; readonly failure: ConfigDependencyFailure }
  | { readonly kind: 'error'; readonly message: string };

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
