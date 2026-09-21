/**
 * Atomic fixture writes for the E2E suites.
 *
 * The suites rewrite fixture configs and sources while the extension, VS Code
 * and the tools they spawn are watching those files. `fs.writeFile` opens the
 * target with `O_TRUNC` and then writes, which is two filesystem operations:
 * on Linux inotify reports the truncation and the payload as separate events,
 * so a watcher that reads on the first one sees an empty file. The suite then
 * races a state no user ever produces — the reason the Linux E2E job did not
 * exist before (see `.github/workflows/ci.yml`). macOS (FSEvents) and Windows
 * coalesce the two, which is why the same suites were green there.
 *
 * Writing a sibling temp file and renaming it over the target replaces the
 * file in one operation, so every watcher sees exactly one event and never an
 * intermediate state. The temp file is created in the target's own directory
 * so the rename stays inside one filesystem (`EXDEV` otherwise), and its name
 * starts with a dot and ends with `.tmp` so it matches none of the config or
 * test-file globs the extension watches.
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

/**
 * `fs.promises.writeFile` with the truncate/write pair replaced by one rename.
 * Use this for every fixture file a watcher may be looking at.
 */
export async function writeFileAtomic(
  filePath: string,
  content: FileContent,
  encoding?: BufferEncoding,
): Promise<void> {
  const temporaryPath = temporaryPathFor(filePath);
  try {
    await fs.promises.writeFile(temporaryPath, content, encoding);
    await fs.promises.rename(temporaryPath, filePath);
  } finally {
    await fs.promises.rm(temporaryPath, { force: true });
  }
}
