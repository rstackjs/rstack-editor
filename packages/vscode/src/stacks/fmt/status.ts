import type { StackState } from '../../types';

/**
 * A folder runtime's lifecycle state, as the E2E exports report it.
 *
 * `disabled`, `version-mismatch` and `crashed` are the states the fold below
 * surfaces to the shell; `stopped` is a runtime that was never started or was
 * shut down deliberately (mid-restart, mid-teardown).
 */
export type FmtRuntimeState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'disabled'
  | 'version-mismatch'
  | 'crashed';

/** One folder runtime's contribution to the stack's single status report. */
export interface FmtFolderStatus {
  readonly name: string;
  readonly state: FmtRuntimeState;
  /**
   * The user-facing sentence behind a `disabled`/`version-mismatch`/`crashed`
   * state. Folder-agnostic on purpose: the fold prefixes the folder name when
   * the window has more than one folder, so no message has to guess where it
   * will be displayed.
   */
  readonly detail: string;
  /**
   * A non-gating warning while the folder keeps formatting — today only the
   * configured-pin-below-floor verdict. Folded at `version-mismatch` rank,
   * like the test stack's configured-pin advisory, because the fix it asks
   * for is the same.
   */
  readonly advisory: string | undefined;
}

/**
 * Severity of each runtime state, worst first. A `Record` over the full union
 * on purpose: a new state cannot be added without ranking itself, so nothing
 * silently falls through to `running` — which is the exact bug class the fold
 * exists to prevent (`statusBar.ts` keeps its severity table for the same
 * reason).
 *
 * `disabled` outranks `running` — deliberately the opposite of the shell's
 * and lint's tables, where `disabled` is a kill switch the user flipped. Here
 * it means "this folder has no `rstack` installed and will never format", a
 * fact worth showing over a healthy sibling. `stopped` ranks with `starting`:
 * both are "no server right now, none of it an error" (a restart passes
 * through `stopped` on its way back up).
 */
const STATE_RANK: Readonly<Record<FmtRuntimeState, number>> = {
  crashed: 5,
  'version-mismatch': 4,
  disabled: 3,
  starting: 2,
  stopped: 2,
  running: 1,
};

/**
 * The states a detection pass restarts instead of keeping: nothing about a
 * failed runtime is worth preserving, and the pass may be the very install or
 * upgrade that fixes it — detection notifies on lockfile events even when the
 * detected folder set is unchanged, for exactly this retry. `starting` is
 * deliberately not here: interrupting a server mid-start on every lockfile
 * event would thrash a healthy launch, and a start that ends in failure is
 * retried by the next pass.
 */
export const isFailedFmtState = (state: FmtRuntimeState): boolean =>
  state === 'disabled' || state === 'version-mismatch' || state === 'crashed';

/**
 * Folds every folder runtime's state into the one report the shell shows for
 * the fmt stack. The worst folder wins, and with multiple folders the detail
 * names the folders it came from — "crashed" without a folder name is not
 * actionable. A healthy sibling starting or recovering can therefore never
 * overwrite another folder's failure: it only changes its own contribution.
 *
 * No folder `running` yet — including the moment before any runtime exists —
 * reports `starting`, not `running`: during Node preflight and server
 * initialization no formatting provider is registered, and the status must
 * not claim otherwise.
 *
 * `runningDetail` is the reason the stack is on (where it was detected),
 * reported when every folder runs clean.
 */
export const foldFolderStatus = (
  statuses: readonly FmtFolderStatus[],
  runningDetail: string,
): StackState => {
  // A running folder carrying an advisory competes as a `version-mismatch`:
  // the server formats, but the status has a warning to show.
  const effective = statuses.map((status) =>
    status.state === 'running' && status.advisory !== undefined
      ? {
          name: status.name,
          state: 'version-mismatch' as const,
          detail: status.advisory,
        }
      : status,
  );
  // No runtimes yet (the moment between registration and the first
  // reconcile) is the same truth as every runtime still starting.
  let worst: FmtRuntimeState = effective[0]?.state ?? 'starting';
  for (const { state } of effective) {
    if (STATE_RANK[state] > STATE_RANK[worst]) {
      worst = state;
    }
  }

  const multiRoot = statuses.length > 1;
  const details = effective
    .filter((entry) => entry.state === worst && entry.detail !== '')
    .map((entry) =>
      multiRoot ? `${entry.name}: ${entry.detail}` : entry.detail,
    );
  const detail = details.length > 0 ? details.join(' | ') : undefined;

  switch (worst) {
    case 'crashed':
      return {
        kind: 'crashed',
        detail: detail ?? 'the rs fmt language server stopped',
      };
    case 'version-mismatch':
      return {
        kind: 'version-mismatch',
        detail: detail ?? 'unsupported rstack version',
      };
    case 'disabled':
      return { kind: 'disabled', reason: detail };
    case 'starting':
    case 'stopped':
      return { kind: 'starting', detail: runningDetail };
    case 'running':
      return { kind: 'running', detail: runningDetail };
  }
};
