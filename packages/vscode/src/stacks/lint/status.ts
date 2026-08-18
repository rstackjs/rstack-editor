import type { StackState } from '../../types';
import { RslintResolutionError } from './resolution';

export class RslintVersionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RslintVersionMismatchError';
  }
}

export const statusForRslintStartFailure = (error: unknown): StackState => {
  if (error instanceof RslintVersionMismatchError) {
    return { kind: 'version-mismatch', detail: error.message };
  }
  if (
    error instanceof RslintResolutionError &&
    error.code === 'missing-rstack'
  ) {
    return {
      kind: 'disabled',
      reason:
        'rstack is not installed (node_modules missing) — install it, then restart Rslint if this status stays',
    };
  }
  return {
    kind: 'crashed',
    detail: error instanceof Error ? error.message : String(error),
  };
};

export const runningRslintStatus = (advisory?: string): StackState =>
  advisory === undefined
    ? { kind: 'running' }
    : { kind: 'version-mismatch', detail: advisory };
