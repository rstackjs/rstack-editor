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

export const errorMessage = (error: unknown): string =>
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

/** How an `rs fmt` child ended. */
type RsFmtExit =
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'close'; readonly code: number | null };

/**
 * Only the tail of stderr is ever reported, but a parked standby can hold a
 * child for minutes — a chatty one must not grow the buffer without bound.
 */
const MAX_STDERR_CHARS = 64 * 1024;

/** Built once: `process.env` does not change over an extension host's life. */
const CHILD_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

/**
 * A spawned `rs fmt --stdin-filepath` child whose streams drain from the moment
 * it starts. Both fmt paths share it: a cold format writes stdin immediately,
 * while a standby parks the child on stdin — `rs fmt` loads the project config
 * concurrently with draining stdin, so a parked child has already paid that
 * cost — and writes only when a request consumes it.
 */
export interface RsFmtProcess {
  readonly rsBinJs: string;
  /**
   * The terminal event. It is a value rather than a callback slot because the
   * child has two independent observers over its life: the standby watches it
   * while parked, and `serveRsFmt` watches it for the duration of a request.
   */
  readonly exited: Promise<RsFmtExit>;
  /** Sends the document and closes stdin. */
  write(text: string): void;
  kill(): void;
  /** Chunks collected so far; joined once the child closes. */
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

export interface RsFmtSpawn {
  readonly filePath: string;
  readonly cwd: string;
  readonly rsBinJs: string;
}

export type RsFmtSpawnResult =
  | { readonly kind: 'spawned'; readonly process: RsFmtProcess }
  | { readonly kind: 'error'; readonly error: unknown };

/** Starts an `rs fmt` child and begins draining its streams. */
export const spawnRsFmt = (options: RsFmtSpawn): RsFmtSpawnResult => {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      process.execPath,
      [
        options.rsBinJs,
        'fmt',
        '--stdin-filepath',
        options.filePath,
        '--ignore-unknown',
      ],
      {
        cwd: options.cwd,
        env: CHILD_ENV,
        stdio: 'pipe',
      },
    );
  } catch (error) {
    return { kind: 'error', error };
  }

  const stdout: string[] = [];
  const stderr: string[] = [];
  let stderrChars = 0;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => stdout.push(chunk));
  child.stderr.on('data', (chunk: string) => {
    stderr.push(chunk);
    stderrChars += chunk.length;
    while (stderrChars > MAX_STDERR_CHARS && stderr.length > 1) {
      const dropped = stderr.shift();
      stderrChars -= dropped?.length ?? 0;
    }
  });
  // A child may reject the request before consuming stdin. Its exit status is
  // authoritative; EPIPE and write-after-end must not become unhandled errors.
  child.stdin.on('error', () => {});

  const exited = new Promise<RsFmtExit>((resolve) => {
    child.on('error', (error) => resolve({ kind: 'error', error }));
    child.on('close', (code) => resolve({ kind: 'close', code }));
  });

  return {
    kind: 'spawned',
    process: {
      rsBinJs: options.rsBinJs,
      stdout,
      stderr,
      exited,
      write(text) {
        try {
          child.stdin.end(text);
        } catch {
          // Wait for the child's close/error event.
        }
      },
      kill() {
        child.kill();
      },
    },
  };
};

const interpretExit = (
  rsFmt: RsFmtProcess,
  text: string,
  code: number | null,
): RsFmtResult => {
  const formatted = rsFmt.stdout.join('');
  const stderrText = rsFmt.stderr.join('');
  if (code === 0) {
    if (formatted.length > 0 || text.trim() === '') {
      return { kind: 'ok', formatted, stderr: stderrText };
    }
    return { kind: 'skipped', stderr: stderrText };
  }
  const tail = stderrTail(stderrText);
  const missingEntry = stderrText
    .split(/\r?\n/)
    .some(
      (line) =>
        line.includes('Cannot find module') && line.includes(rsFmt.rsBinJs),
    );
  if (missingEntry) {
    return launchError(rsFmt.rsBinJs, tail);
  }
  return {
    kind: 'error',
    message:
      tail ||
      `rs fmt exited with code ${code === null ? 'unknown' : String(code)}`,
  };
};

export interface RsFmtServe {
  readonly process: RsFmtProcess;
  readonly text: string;
  readonly signal: AbortSignal;
  /**
   * Guard timeout. It measures the request, so for a standby it starts at
   * consume time rather than at spawn time.
   */
  readonly timeoutMs?: number;
}

/** Writes the document to a child's stdin and resolves with its verdict. */
export const serveRsFmt = (serve: RsFmtServe): Promise<RsFmtResult> =>
  new Promise((resolve) => {
    const rsFmt = serve.process;
    const signal = serve.signal;
    const timeoutMs = serve.timeoutMs ?? TIMEOUT_MS;
    let settled = false;
    // Boxed rather than a plain `let`: the timeout is assigned below the
    // closure that clears it, and `prefer-const` mis-reads that order as
    // "never reassigned".
    const guard: { timeout?: NodeJS.Timeout } = {};

    const onAbort = (): void => {
      rsFmt.kill();
      settle({ kind: 'cancelled' });
    };
    const settle = (result: RsFmtResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(guard.timeout);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    void rsFmt.exited.then((exit) => {
      if (signal.aborted) {
        settle({ kind: 'cancelled' });
        return;
      }
      settle(
        exit.kind === 'error'
          ? launchError(rsFmt.rsBinJs, errorMessage(exit.error))
          : interpretExit(rsFmt, serve.text, exit.code),
      );
    });
    if (signal.aborted) {
      // `addEventListener` never fires on an already-aborted signal, and a
      // standby's child is not bound to the request signal at spawn time.
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });
    guard.timeout = setTimeout(() => {
      rsFmt.kill();
      settle({
        kind: 'error',
        message: `rs fmt at ${rsFmt.rsBinJs} timed out after ${timeoutMs / 1000} seconds`,
      });
    }, timeoutMs);

    rsFmt.write(serve.text);
  });

export const runRsFmt = async (run: RsFmtRun): Promise<RsFmtResult> => {
  if (run.signal.aborted) {
    return { kind: 'cancelled' };
  }

  const spawned = spawnRsFmt({
    filePath: run.filePath,
    cwd: run.cwd,
    rsBinJs: run.rsBinJs,
  });
  if (spawned.kind === 'error') {
    return launchError(run.rsBinJs, errorMessage(spawned.error));
  }

  return serveRsFmt({
    process: spawned.process,
    text: run.text,
    signal: run.signal,
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
