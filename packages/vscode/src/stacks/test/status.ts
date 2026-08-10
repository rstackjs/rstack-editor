import type { StackState, StatusReporter } from '../../types';

/**
 * The latch key for facts about the extension host rather than about one
 * resolution root — today, which Node.js the workers can run on. There is one
 * PATH and one shell, so filing this under a project's source URI would write N
 * entries for one fact and let any one project's unrelated recovery clear it.
 * Declared here, beside the latch contract it participates in, rather than at
 * the call site that happens to raise it.
 */
export const NODE_RUNTIME_STATUS_SOURCE = 'host:node-runtime';

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
  // that was neither recovered nor retried. Each latch is keyed by its
  // reporting site's identity — a master reports under its project's source
  // URI (unique per project, so sibling configs in one directory stay
  // independent), a bridge shim resolution under its config directory, and a
  // fact about the extension host itself under `NODE_RUNTIME_STATUS_SOURCE`
  // below; the three namespaces (URI string, filesystem path, `host:`) never
  // collide. A recovery observed under one key must not clear another key's
  // live failure. An entry is cleared by the code path that observes the
  // corresponding recovery (a worker that actually spawned, a version check
  // that passed) or by `forget` when its reporter goes away — neither of which
  // reaches a host-scoped entry, since both are per-resolution-root. A
  // host-scoped latch is cleared only by `bind`, i.e. by re-registering the
  // stack, which is exactly the lifetime of the resolution it reports on.
  #crashes = new Map<string, string>();
  #mismatches = new Map<string, string>();
  #lastRunningDetail: string | undefined;

  get stack() {
    return this.#reporter?.stack ?? ('rstest' as const);
  }

  public bind(reporter: StatusReporter) {
    this.#reporter = reporter;
    this.#crashes.clear();
    this.#mismatches.clear();
    this.#lastRunningDetail = undefined;
  }

  public unbind() {
    this.#reporter = undefined;
  }

  get #latched(): boolean {
    return this.#crashes.size > 0 || this.#mismatches.size > 0;
  }

  /**
   * Worst live state first: a crash outranks a version mismatch. Within one
   * severity the oldest unrecovered entry wins, keeping the display stable
   * while other roots come and go.
   */
  #paintOrRun(): void {
    const [crash] = this.#crashes.values();
    if (crash !== undefined) {
      this.#reporter?.crashed(crash);
      return;
    }
    const [mismatch] = this.#mismatches.values();
    if (mismatch !== undefined) {
      this.#reporter?.versionMismatch(mismatch);
      return;
    }
    this.#reporter?.running(this.#lastRunningDetail);
  }

  report(state: StackState): void {
    this.#reporter?.report(state);
  }

  starting(detail?: string): void {
    if (this.#latched) return;
    this.#reporter?.starting(detail);
  }

  running(detail?: string): void {
    this.#lastRunningDetail = detail;
    if (this.#latched) return;
    this.#reporter?.running(detail);
  }

  crashed(detail: string, source = ''): void {
    this.#crashes.set(source, detail);
    this.#paintOrRun();
  }

  versionMismatch(detail: string, source = ''): void {
    this.#mismatches.set(source, detail);
    this.#paintOrRun();
  }

  /** A worker process came up: that root's previous spawn failure is over. */
  workerSpawned(source = ''): void {
    if (!this.#crashes.delete(source)) return;
    this.#paintOrRun();
  }

  /** A package version check passed: that root's previous mismatch is resolved. */
  versionOk(source = ''): void {
    if (!this.#mismatches.delete(source)) return;
    this.#paintOrRun();
  }

  /**
   * A resolution root went away (its config file or workspace folder was
   * removed) without recovering: its failures must not outlive it and keep
   * suppressing the surviving roots' status.
   */
  forget(source: string): void {
    const hadCrash = this.#crashes.delete(source);
    const hadMismatch = this.#mismatches.delete(source);
    if (hadCrash || hadMismatch) this.#paintOrRun();
  }
}

export const status = new StatusHolder();
