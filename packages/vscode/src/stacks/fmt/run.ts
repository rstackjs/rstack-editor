import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

const TIMEOUT_MS = 60_000;
const LAUNCH_ERROR_PREFIX = 'Unable to run rs fmt at ';

/** Deepest config directory that contains the document, or the workspace root. */
export const pickConfigDir = (
  documentPath: string,
  configFilePaths: readonly string[],
  fallbackDir: string,
): string => {
  const documentDir = path.dirname(path.resolve(documentPath));
  let selected = path.resolve(fallbackDir);
  let selectedDepth = -1;

  for (const configFilePath of configFilePaths) {
    const configDir = path.dirname(path.resolve(configFilePath));
    const relative = path.relative(configDir, documentDir);
    const containsDocument =
      relative === '' ||
      (relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative));
    if (!containsDocument) {
      continue;
    }

    const depth = configDir.split(path.sep).filter(Boolean).length;
    if (depth > selectedDepth) {
      selected = configDir;
      selectedDepth = depth;
    }
  }

  return selected;
};

export interface RsFmtRun {
  readonly text: string;
  readonly filePath: string;
  readonly cwd: string;
  readonly rsBinJs: string;
  readonly signal: AbortSignal;
}

export type RsFmtResult =
  // `stderr` carries the CLI's own voice (warnings on otherwise-successful
  // runs) so the caller can surface it, the way an LSP-based tool would push
  // `window/logMessage`.
  | { readonly kind: 'ok'; readonly formatted: string; readonly stderr: string }
  | { readonly kind: 'skipped'; readonly stderr: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly message: string };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Bounds any CLI stderr headed for a log line to its meaningful tail. */
export const stderrTail = (stderr: string): string =>
  stderr.trim().split(/\r?\n/).slice(-10).join('\n');

const launchError = (rsBinJs: string, detail: string): RsFmtResult => ({
  kind: 'error',
  message: `${LAUNCH_ERROR_PREFIX}${rsBinJs}: ${detail}`,
});

/** True only when the CLI itself could not be launched or loaded. */
export const isRsFmtLaunchError = (result: RsFmtResult): boolean =>
  result.kind === 'error' && result.message.startsWith(LAUNCH_ERROR_PREFIX);

export const runRsFmt = async (run: RsFmtRun): Promise<RsFmtResult> => {
  if (run.signal.aborted) {
    return { kind: 'cancelled' };
  }

  return new Promise((resolve) => {
    let settled = false;
    const guard: { timeout?: NodeJS.Timeout } = {};
    let child: ChildProcessWithoutNullStreams | undefined;

    const onAbort = (): void => {
      child?.kill();
      settle({ kind: 'cancelled' });
    };
    const settle = (result: RsFmtResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (guard.timeout) {
        clearTimeout(guard.timeout);
      }
      run.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    try {
      child = spawn(
        process.execPath,
        [
          run.rsBinJs,
          'fmt',
          '--stdin-filepath',
          run.filePath,
          '--ignore-unknown',
        ],
        {
          cwd: run.cwd,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          signal: run.signal,
          stdio: 'pipe',
        },
      );
    } catch (error) {
      settle(
        run.signal.aborted
          ? { kind: 'cancelled' }
          : launchError(run.rsBinJs, errorMessage(error)),
      );
      return;
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdout.push(chunk));
    child.stderr.on('data', (chunk: string) => stderr.push(chunk));
    child.on('error', (error) => {
      settle(
        run.signal.aborted
          ? { kind: 'cancelled' }
          : launchError(run.rsBinJs, errorMessage(error)),
      );
    });
    child.on('close', (code) => {
      if (run.signal.aborted) {
        settle({ kind: 'cancelled' });
        return;
      }

      const formatted = stdout.join('');
      const stderrText = stderr.join('');
      if (code === 0) {
        if (formatted.length > 0 || run.text.trim() === '') {
          settle({ kind: 'ok', formatted, stderr: stderrText });
        } else {
          settle({ kind: 'skipped', stderr: stderrText });
        }
        return;
      }
      const tail = stderrTail(stderrText);
      const missingEntry = stderrText
        .split(/\r?\n/)
        .some(
          (line) =>
            line.includes('Cannot find module') && line.includes(run.rsBinJs),
        );
      if (missingEntry) {
        settle(launchError(run.rsBinJs, tail));
        return;
      }
      settle({
        kind: 'error',
        message:
          tail ||
          `rs fmt exited with code ${code === null ? 'unknown' : String(code)}`,
      });
    });

    run.signal.addEventListener('abort', onAbort, { once: true });
    guard.timeout = setTimeout(() => {
      child?.kill();
      settle({
        kind: 'error',
        message: `rs fmt at ${run.rsBinJs} timed out after ${TIMEOUT_MS / 1000} seconds`,
      });
    }, TIMEOUT_MS);

    // A child may reject the request before consuming stdin. Its exit status is
    // authoritative; EPIPE and write-after-end must not become unhandled errors.
    child.stdin.on('error', () => {});
    try {
      child.stdin.end(run.text);
    } catch {
      // Wait for the child's close/error event.
    }
  });
};

/** A single minimal replacement, expressed as offsets to stay vscode-free. */
export const minimalEdit = (
  original: string,
  formatted: string,
): { start: number; end: number; newText: string } | undefined => {
  if (original === formatted) {
    return undefined;
  }

  let start = 0;
  const sharedLength = Math.min(original.length, formatted.length);
  while (start < sharedLength && original[start] === formatted[start]) {
    start += 1;
  }

  let originalEnd = original.length;
  let formattedEnd = formatted.length;
  while (
    originalEnd > start &&
    formattedEnd > start &&
    original[originalEnd - 1] === formatted[formattedEnd - 1]
  ) {
    originalEnd -= 1;
    formattedEnd -= 1;
  }

  return {
    start,
    end: originalEnd,
    newText: formatted.slice(start, formattedEnd),
  };
};
