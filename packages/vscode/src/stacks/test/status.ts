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

  get stack() {
    return this.#reporter?.stack ?? ('rstest' as const);
  }

  public bind(reporter: StatusReporter) {
    this.#reporter = reporter;
  }

  public unbind() {
    this.#reporter = undefined;
  }

  report(state: StackState): void {
    this.#reporter?.report(state);
  }

  starting(detail?: string): void {
    this.#reporter?.starting(detail);
  }

  running(detail?: string): void {
    this.#reporter?.running(detail);
  }

  crashed(detail: string): void {
    this.#reporter?.crashed(detail);
  }

  versionMismatch(detail: string): void {
    this.#reporter?.versionMismatch(detail);
  }
}

export const status = new StatusHolder();
