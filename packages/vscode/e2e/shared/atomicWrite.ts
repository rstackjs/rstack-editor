/**
 * EXPERIMENT (do not merge): plain fixture writes.
 *
 * The rename-based implementation is replaced by a bare `fs.promises.write
 * File` so a Linux E2E run measures whether the suites actually race the
 * truncate/write pair inotify reports as two events. The signature is
 * unchanged, so no call site moves.
 */
import fs from 'node:fs';

export type FileContent = string | NodeJS.ArrayBufferView;

export async function writeFileAtomic(
  filePath: string,
  content: FileContent,
  encoding?: BufferEncoding,
): Promise<void> {
  return fs.promises.writeFile(filePath, content, encoding);
}
