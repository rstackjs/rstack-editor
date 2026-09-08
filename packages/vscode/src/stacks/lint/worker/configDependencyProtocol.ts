import type { ConfigDependencyFailure } from '../../../shared/notInstalled';
import { isRecord } from './core';

export const CONFIG_DEPENDENCY_STATUS_NOTIFICATION =
  'rstack/rslintConfigDependency';

export type ConfigDependencyStatusNotification =
  | { readonly kind: 'ok' }
  | { readonly kind: 'missing'; readonly failure: ConfigDependencyFailure }
  | { readonly kind: 'error'; readonly message: string };

/** Shared with the editor's startup retry; this module stays vscode-free. */
export function isConfigSourceChangeDuringTransaction(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return (
    error.code === 'CONFIG_CHANGED_DURING_LOAD' ||
    (typeof error.message === 'string' &&
      error.message.includes('config changed while'))
  );
}
