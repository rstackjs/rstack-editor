/**
 * Atomic fixture writes for the E2E suites.
 *
 * The suites rewrite fixture configs and sources while the extension, VS Code
 * and the tools they spawn are watching those files. `fs.writeFileSync` opens
 * the target with `O_TRUNC` and then writes, which is two filesystem
 * operations: on Linux inotify reports the truncation and the payload as
 * separate events, so a watcher that reads on the first one sees an empty
 * file. The suite then races a state no user ever produces — the reason the
 * Linux E2E job did not exist before (see `.github/workflows/ci.yml`).
 * macOS (FSEvents) and Windows coalesce the two, which is why the same suites
 * were green there.
 *
 * Writing a sibling temp file and renaming it over the target replaces the
 * file in one operation, so every watcher sees exactly one event and never an
 * intermediate state. The temp file is created in the target's own directory
 * so the rename stays inside one filesystem (`EXDEV` otherwise), and its name
 * starts with a dot and ends with `.tmp` so it matches none of the config or
 * test-file globs the extension watches.
 *
 * Windows caveat: `rename` over a file another process holds open fails with
 * `EPERM` / `EBUSY`. The rename is retried a few times and then falls back to
 * a plain write, which is exactly what these call sites did before — Windows
 * keeps its previous behavior in the worst case and gains atomicity in the
 * common one.
 */
import fs from 'node:fs';
import path from 'node:path';

export type FileContent = string | NodeJS.ArrayBufferView;

let sequence = 0;

const temporaryPathFor = (filePath: string): string => {
  sequence += 1;
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${sequence}.tmp`,
  );
};

const RENAME_RETRY_DELAYS_MS = [5, 15, 40, 100];

const isLockedError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
};

/** Blocking sleep — the sync path runs inside Mocha's synchronous steps. */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `fs.writeFileSync` with the truncate/write pair replaced by one rename.
 * Use this for every fixture file a watcher may be looking at.
 */
export function writeFileAtomicSync(
  filePath: string,
  content: FileContent,
  encoding?: BufferEncoding,
): void {
  const temporaryPath = temporaryPathFor(filePath);
  try {
    fs.writeFileSync(temporaryPath, content, encoding);
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temporaryPath, filePath);
        return;
      } catch (error) {
        if (!isLockedError(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
          if (!isLockedError(error)) throw error;
          // The target stayed locked; fall back to the non-atomic write the
          // call site used before this helper existed.
          fs.writeFileSync(filePath, content, encoding);
          return;
        }
        sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
      }
    }
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

/** The `node:fs/promises` counterpart of {@link writeFileAtomicSync}. */
export async function writeFileAtomic(
  filePath: string,
  content: FileContent,
  encoding?: BufferEncoding,
): Promise<void> {
  const temporaryPath = temporaryPathFor(filePath);
  try {
    await fs.promises.writeFile(temporaryPath, content, encoding);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.promises.rename(temporaryPath, filePath);
        return;
      } catch (error) {
        if (!isLockedError(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
          if (!isLockedError(error)) throw error;
          await fs.promises.writeFile(filePath, content, encoding);
          return;
        }
        await sleep(RENAME_RETRY_DELAYS_MS[attempt]);
      }
    }
  } finally {
    await fs.promises.rm(temporaryPath, { force: true });
  }
}
