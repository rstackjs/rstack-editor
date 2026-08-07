import {
  errorMessage,
  type RsFmtProcess,
  type RsFmtResult,
  serveRsFmt,
  spawnRsFmt,
} from './run';

/**
 * What a standby is bound to. `rs fmt` reads `--stdin-filepath` from argv and
 * resolves its config from the spawn cwd, so none of the three can change
 * after the process starts: a request that does not match all three has to be
 * formatted cold.
 */
export interface StandbyKey {
  readonly cwd: string;
  readonly filePath: string;
  readonly rsBinJs: string;
}

export const sameStandbyKey = (left: StandbyKey, right: StandbyKey): boolean =>
  left.cwd === right.cwd &&
  left.filePath === right.filePath &&
  left.rsBinJs === right.rsBinJs;

/**
 * How long an armed-but-unconsumed standby is kept. Reaping is not an error —
 * it reclaims the memory of a process nobody is going to use, and the next
 * eligible event arms a new one.
 */
const IDLE_TIMEOUT_MS = 5 * 60_000;

export interface FmtStandbyOptions {
  /**
   * Debug-level sink. The standby is invisible to the user: arming never
   * reports status and never logs above debug.
   */
  readonly log: (message: string) => void;
  /** Idle lifetime of an armed standby; injected short by the unit tests. */
  readonly idleTimeoutMs?: number;
  /** Guard timeout for a hot format; starts at consume, not at spawn. */
  readonly requestTimeoutMs?: number;
}

interface ArmedStandby {
  readonly key: StandbyKey;
  readonly process: RsFmtProcess;
  readonly idleTimer: NodeJS.Timeout;
}

/**
 * The single pre-spawned `rs fmt` process that tracks the active editor.
 *
 * It is a bounded exception to the extension's "no warm tier" rule: at most one
 * process, bound to one file, serving exactly one request. There is no
 * protocol, no pool and no state carried between requests — everything the
 * standby saves is the process start-up plus config load a cold format pays on
 * the critical path.
 *
 * Deliberately vscode-free (like `run.ts`) so the whole lifecycle is unit
 * testable; the controller owns every VS Code event that drives it.
 */
export class FmtStandby {
  #armed: ArmedStandby | undefined;
  #disposed = false;

  constructor(private readonly options: FmtStandbyOptions) {}

  /** The file the standby currently targets, if any. */
  get armedFilePath(): string | undefined {
    return this.#armed?.key.filePath;
  }

  /**
   * Spawns the standby for `key`, replacing any standby on another key.
   * Returns whether a standby is now armed for `key`. Failures are reported
   * through `log` only: a standby that cannot be armed costs a cold format,
   * never a user-visible error.
   */
  arm(key: StandbyKey): boolean {
    if (this.#disposed) {
      return false;
    }
    if (this.#armed) {
      if (sameStandbyKey(this.#armed.key, key)) {
        return true;
      }
      // Replacing, not invalidating: the caller is already arming the
      // replacement, so this kill must not ask for another one.
      this.kill('the active editor moved to another file');
    }

    const spawned = spawnRsFmt({
      cwd: key.cwd,
      filePath: key.filePath,
      rsBinJs: key.rsBinJs,
    });
    if (spawned.kind === 'error') {
      this.options.log(
        `Standby not armed for ${key.filePath}: ${errorMessage(spawned.error)}`,
      );
      return false;
    }

    const armed: ArmedStandby = {
      key,
      process: spawned.process,
      idleTimer: setTimeout(() => {
        this.kill('reaped after idling');
      }, this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS),
    };
    this.#armed = armed;
    // A parked child that dies on its own (a crash, a config load throwing) is
    // not an error either — the next request simply formats cold. The identity
    // check is what makes this a no-op once the child has been consumed or
    // replaced, so nothing has to unsubscribe.
    void spawned.process.exited.then(() => {
      if (this.#armed === armed) {
        this.kill('the parked process exited');
      }
    });
    this.options.log(`Standby armed for ${key.filePath}`);
    return true;
  }

  /**
   * Serves one format request from the standby, or returns `undefined` when it
   * cannot — nothing armed, a different key, or a standby already taken by a
   * concurrent request. The caller then formats cold.
   */
  consume(
    key: StandbyKey,
    request: { readonly text: string; readonly signal: AbortSignal },
  ): Promise<RsFmtResult> | undefined {
    const armed = this.#armed;
    if (!armed || !sameStandbyKey(armed.key, key)) {
      return undefined;
    }
    // A standby serves exactly one request. Taking it here is also what makes a
    // second, concurrent request miss and go cold.
    this.#armed = undefined;
    clearTimeout(armed.idleTimer);
    this.options.log(`Standby consumed for ${key.filePath}`);
    return serveRsFmt({
      process: armed.process,
      text: request.text,
      signal: request.signal,
      timeoutMs: this.options.requestTimeoutMs,
    });
  }

  /**
   * Invalidates the standby. The caller re-arms afterwards if the active editor
   * still qualifies — a parked process has already loaded the project config,
   * so a config edit (or any detection change) makes it wrong, not stale.
   */
  kill(reason: string): void {
    const armed = this.#armed;
    if (!armed) {
      return;
    }
    this.#armed = undefined;
    clearTimeout(armed.idleTimer);
    armed.process.kill();
    this.options.log(`Standby killed (${reason})`);
  }

  dispose(): void {
    this.#disposed = true;
    this.kill('the fmt stack was disposed');
  }
}
