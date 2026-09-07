import type { StackState } from '../../types';
import { formatNotInstalledStatus } from '../../shared/notInstalled';
import type { SupportedPackage } from '../../shared/versionCheck';
import { RslintResolutionError } from './resolution';

export class RslintVersionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RslintVersionMismatchError';
  }
}

/**
 * The package whose absence makes this failure the not-installed state the
 * three stacks report uniformly (AGENTS.md) — a `disabled` status and a
 * one-line warning, never a crash or a stack trace. The verdict is the throw
 * site's, carried on the error (`RslintResolutionError.missingPackage`), so
 * a new resolution failure cannot silently fall through to `crashed` here by
 * missing a mapping.
 */
export const missingPackageOf = (
  error: unknown,
): SupportedPackage | undefined =>
  error instanceof RslintResolutionError ? error.missingPackage : undefined;

export const statusForRslintStartFailure = (error: unknown): StackState => {
  if (error instanceof RslintVersionMismatchError) {
    return { kind: 'version-mismatch', detail: error.message };
  }
  const missing = missingPackageOf(error);
  if (missing !== undefined) {
    return {
      kind: 'disabled',
      reason: formatNotInstalledStatus('rslint', missing),
    };
  }
  return {
    kind: 'crashed',
    detail: error instanceof Error ? error.message : String(error),
  };
};

/**
 * Names the Rslint core a runtime's failure came from. With several runtimes
 * in one folder, "the language server stopped" alone does not say which core
 * to look at; the resolver's own messages already carry the directory, so it
 * is appended only when missing.
 */
export const attributeToCore = (
  state: StackState,
  coreDirectory: string,
): StackState => {
  if (state.kind !== 'crashed' && state.kind !== 'version-mismatch') {
    return state;
  }
  if (state.detail.includes(coreDirectory)) return state;
  return { kind: state.kind, detail: `${state.detail} (${coreDirectory})` };
};

export const runningRslintStatus = (advisory?: string): StackState =>
  advisory === undefined
    ? { kind: 'running' }
    : { kind: 'version-mismatch', detail: advisory };

/** A detected folder with no Lint runtime: `running` plus a detail, never a new kind (AGENTS.md, lint gotcha). */
const RSLINT_IDLE_DETAIL = 'idle';

/**
 * Complete on purpose: a new state cannot be added without ranking itself, so
 * nothing silently falls through to `running`. `disabled` outranks `running`
 * as in the fmt stack's table: at folder level it only ever means "a package
 * this folder needs is not installed, so it will not lint" (`missingPackageOf`),
 * a fact worth showing over a healthy runtime or sibling folder — unlike the
 * shell's kill switch.
 */
const STATE_RANK: Readonly<Record<StackState['kind'], number>> = {
  crashed: 5,
  'version-mismatch': 4,
  disabled: 3,
  starting: 2,
  running: 1,
  'not-detected': 0,
};

const detailOf = (state: StackState): string | undefined => {
  switch (state.kind) {
    case 'crashed':
    case 'version-mismatch':
    case 'starting':
    case 'running':
      return state.detail;
    case 'disabled':
      return state.reason;
    case 'not-detected':
      return undefined;
  }
};

const worstKind = (states: readonly StackState[]): StackState['kind'] =>
  states.reduce<StackState['kind']>(
    (worst, state) =>
      STATE_RANK[state.kind] > STATE_RANK[worst] ? state.kind : worst,
    'not-detected',
  );

const joinDetails = (
  details: readonly (string | undefined)[],
): string | undefined => {
  const unique = [
    ...new Set(
      details.filter((detail): detail is string => detail !== undefined),
    ),
  ];
  return unique.length > 0 ? unique.join(' | ') : undefined;
};

/**
 * Folds one workspace folder's Lint runtimes (plus any document whose core
 * resolution failed) into that folder's state.
 *
 * Worst-of, so a healthy runtime never masks a failing one: a folder running
 * two cores where one is below the floor is a folder the user has to fix.
 */
export const foldRslintFolderState = (
  states: readonly StackState[],
): StackState => {
  if (states.length === 0) {
    return { kind: 'running', detail: RSLINT_IDLE_DETAIL };
  }
  const kind = worstKind(states);
  return withDetail(
    kind,
    joinDetails(states.filter((state) => state.kind === kind).map(detailOf)),
  );
};

export interface RslintFolderStatus {
  readonly name: string;
  readonly state: StackState;
}

/**
 * Folds every workspace folder's state into the one state the status bar shows
 * for the Rslint stack. The worst state wins, and the detail names the folders
 * it came from — with multiple roots, "crashed" without a folder name is not
 * actionable.
 */
export const aggregateFolderStates = (
  statuses: readonly RslintFolderStatus[],
): StackState => {
  if (statuses.length === 0) {
    return { kind: 'starting' };
  }
  const kind = worstKind(statuses.map((entry) => entry.state));
  const multiRoot = statuses.length > 1;
  return withDetail(
    kind,
    joinDetails(
      statuses
        .filter((entry) => entry.state.kind === kind)
        .map((entry) => {
          const detail = detailOf(entry.state);
          if (!detail) return multiRoot ? entry.name : undefined;
          return multiRoot ? `${entry.name}: ${detail}` : detail;
        }),
    ),
  );
};

const withDetail = (
  kind: StackState['kind'],
  detail: string | undefined,
): StackState => {
  switch (kind) {
    case 'crashed':
      return {
        kind: 'crashed',
        detail: detail ?? 'the language server failed',
      };
    case 'version-mismatch':
      return {
        kind: 'version-mismatch',
        detail: detail ?? 'unsupported @rslint/core version',
      };
    case 'starting':
      return { kind: 'starting', detail };
    case 'running':
      return { kind: 'running', detail };
    case 'disabled':
      return { kind: 'disabled', reason: detail };
    case 'not-detected':
      return { kind: 'not-detected' };
  }
};
