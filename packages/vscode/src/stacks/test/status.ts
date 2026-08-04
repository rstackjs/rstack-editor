import type { StackState, StatusReporter } from '../../types';

/**
 * The status-aggregation adaptation: the stack owns no status UI. Everything that
 * used to be a one-shot `showWarningMessage` (the `@rstest/core` version check)
 * or an unreported failure is reported through the shell's single aggregated
 * status bar item instead.
 *
 * Like `logger`, this is a module singleton so the deep call sites
 * (`master.ts`) can report without threading a context through every
 * constructor. It no-ops while unbound, which is what the unit tests and a
 * disposed stack see.
 */
class StatusHolder implements StatusReporter {
  #reporter: StatusReporter | undefined;
  // Failure latches. Detection refreshes re-derive `running` from the folder
  // count alone (`reportStatus`), which must not paint over a live failure
  // that was neither recovered nor retried. Each latch is cleared by the
  // code path that observes the corresponding recovery: a worker process
  // that actually spawned, or a version check that passed.
  #crash: string | undefined;
  #mismatch: string | undefined;
  #lastRunningDetail: string | undefined;

  get stack() {
    return this.#reporter?.stack ?? ('rstest' as const);
  }

  public bind(reporter: StatusReporter) {
    this.#reporter = reporter;
    this.#crash = undefined;
    this.#mismatch = undefined;
    this.#lastRunningDetail = undefined;
  }

  public unbind() {
    this.#reporter = undefined;
  }

  /** Worst live state first: a crash outranks a version mismatch. */
  #paintOrRun(): void {
    if (this.#crash !== undefined) {
      this.#reporter?.crashed(this.#crash);
    } else if (this.#mismatch !== undefined) {
      this.#reporter?.versionMismatch(this.#mismatch);
    } else {
      this.#reporter?.running(this.#lastRunningDetail);
    }
  }

  report(state: StackState): void {
    this.#reporter?.report(state);
  }

  starting(detail?: string): void {
    if (this.#crash !== undefined || this.#mismatch !== undefined) return;
    this.#reporter?.starting(detail);
  }

  running(detail?: string): void {
    this.#lastRunningDetail = detail;
    if (this.#crash !== undefined || this.#mismatch !== undefined) return;
    this.#reporter?.running(detail);
  }

  crashed(detail: string): void {
    this.#crash = detail;
    this.#reporter?.crashed(detail);
  }

  versionMismatch(detail: string): void {
    this.#mismatch = detail;
    if (this.#crash === undefined) {
      this.#reporter?.versionMismatch(detail);
    }
  }

  /** A worker process came up: the previous spawn failure is over. */
  workerSpawned(): void {
    if (this.#crash === undefined) return;
    this.#crash = undefined;
    this.#paintOrRun();
  }

  /** A package version check passed: the previous mismatch is resolved. */
  versionOk(): void {
    if (this.#mismatch === undefined) return;
    this.#mismatch = undefined;
    this.#paintOrRun();
  }
}

export const status = new StatusHolder();
