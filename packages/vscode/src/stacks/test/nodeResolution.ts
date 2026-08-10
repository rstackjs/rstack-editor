import { execFile, spawn } from 'node:child_process';
import { checkVersion, NODE_RUNTIME_RANGE } from '../../shared/versionCheck';

/**
 * Choosing the Node.js a test worker runs on.
 *
 * The bare `node` a GUI extension host inherits is a *login-shell* snapshot
 * taken at startup — typically a version manager's global default rather than
 * the version the user's terminal would give them. Measured on one developer
 * machine: login shell `node` was 20.19.4 while the interactive shell was
 * 22.23.1. So "what is on PATH" is not a reliable answer, and asking the user's
 * own shell is the recovery path.
 *
 * The floor (`NODE_RUNTIME_RANGE`, in `shared/versionCheck`) is uniform rather
 * than per-project. It is set by the strictest thing a worker does — load an
 * `rstack.config.*` — and applying it to every project, including a native
 * `rstest.config.*` that Rsbuild's bundled jiti would load on older engines, is
 * a deliberate simplification: it drops only Node 20, whose support window
 * ended 2026-04-30 (`nodejs/Release`), and keeps one code path instead of two.
 *
 * There is deliberately NO fallback to the extension host's own runtime
 * (`process.execPath` + `ELECTRON_RUN_AS_NODE`). It would silently move the
 * test run onto Electron's Node — a different ABI line (measured: Electron
 * reports NODE_MODULE_VERSION 146 where plain Node 24.18 reports 137, so
 * non-N-API addons fail to load) and a version chosen by VS Code's release
 * cadence rather than by the project. A green run has to mean the same thing in
 * the editor as in the terminal.
 */

/**
 * The status-latch key for a failed preflight. The reporting site's identity is
 * the *host*, not a project: there is one PATH and one shell, so filing this
 * under a project's source URI would write N entries for one fact and let any
 * one project's unrelated recovery (`status.versionOk` after the `@rstest/core`
 * package check) or disposal clear it. The `host:` prefix cannot collide with
 * the URI and filesystem-path namespaces `status.ts` documents.
 */
export const NODE_RUNTIME_STATUS_SOURCE = 'host:node-runtime';

/** `node --version` is instant when it works; a slow answer is a broken one. */
const VERSION_PROBE_TIMEOUT_MS = 3_000;
const SHELL_PROBE_TIMEOUT_MS = 5_000;

/**
 * VS Code resolves the shell environment asynchronously while extensions are
 * already activating, so a `node` that is genuinely installed can be missing
 * from `process.env.PATH` for the first moments of a session. Upstream Vitest
 * waits the same way. Only a `not-found` is retried — an executable that ran
 * and failed will fail again, and paying the probe timeout six times over is
 * how a pathological case turns into a minute of silence.
 */
const NOT_FOUND_RETRIES = 5;
const NOT_FOUND_RETRY_DELAY_MS = 200;

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * What became of running `<executable> --version`. `ok` with no version is the
 * soft pass: an unparseable version must never cost the feature (the rule lives
 * in `checkVersion`). The three cases are a union rather than a boolean plus an
 * optional field so that "not found, but here is a version" is unrepresentable.
 */
export type NodeProbe =
  | { readonly kind: 'ok'; readonly version?: string }
  /** Nothing to execute — the one case worth retrying. */
  | { readonly kind: 'not-found' }
  /** It exists but did not answer: non-zero exit, or hung past the timeout. */
  | { readonly kind: 'unusable' };

export type WorkerNodeResolution = {
  readonly executable: string;
  /** Which candidate won. Drives the fallback notice, nothing else. */
  readonly source: 'path' | 'shell';
  /** Absent when the version could not be parsed (the soft pass). */
  readonly version?: string;
};

/** What each candidate turned out to be, in the order they were tried. */
export type NodeAttempts = {
  /** The PATH `node`'s version, or `undefined` when none answered. */
  readonly path?: string;
  /** The shell's `node` version, or `undefined` when it found none. */
  readonly shell?: string;
  /** True when the shell was never asked: Windows, or no known shell. */
  readonly shellSkipped: boolean;
};

const describeCandidate = (label: string, version: string | undefined) =>
  version === undefined ? `${label}: none found` : `${label}: ${version}`;

const formatNodePreflightFailure = (attempts: NodeAttempts): string => {
  const candidates = [
    describeCandidate('PATH', attempts.path),
    attempts.shellSkipped
      ? 'interactive shell: not probed'
      : describeCandidate('interactive shell', attempts.shell),
  ].join(', ');
  return `No Node.js ${NODE_RUNTIME_RANGE} is available to run tests (${candidates}). Rstest needs it to load TypeScript config files. Install a newer Node.js, or set "rstack.rstest.nodeExecutable" to one.`;
};

/** No candidate satisfied `NODE_RUNTIME_RANGE`. */
export class NodePreflightError extends Error {
  constructor(readonly attempts: NodeAttempts) {
    super(formatNodePreflightFailure(attempts));
    this.name = 'NodePreflightError';
  }
}

export const probeNodeVersion = (executable: string): Promise<NodeProbe> =>
  new Promise((resolve) => {
    execFile(
      executable,
      ['--version'],
      { timeout: VERSION_PROBE_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          // `ExecFileException.code` widens to `string | number`: a spawn
          // failure carries the errno string, an exit carries the status.
          resolve({ kind: error.code === 'ENOENT' ? 'not-found' : 'unusable' });
          return;
        }
        const version = stdout.trim().replace(/^v/, '');
        resolve({ kind: 'ok', version: version === '' ? undefined : version });
      },
    );
  });

const START_TOKEN = '__RSTACK_NODE_START__';
const END_TOKEN = '__RSTACK_NODE_END__';

/**
 * Asks the user's own shell where its `node` is, the way their terminal would
 * answer. This is what makes a version manager work: its hooks live in the
 * interactive rc files that the extension host's login-shell snapshot never
 * ran.
 *
 * `node --version` runs first and its output is discarded — lazily-loading
 * version managers define `node` as a shell function that only materializes a
 * real binary once called, so without it `command -v` would find nothing.
 * `command -v` rather than `which`, and no `[[ ]]`, so the script parses in
 * fish as well as bash/zsh. The shell is spawned argv-style rather than through
 * an outer `sh -c`, so no quoting is involved and the timeout kills the shell
 * itself rather than a wrapper.
 *
 * Returns `undefined` on any failure; a shell that hangs on a slow rc file must
 * cost a bounded wait, not the Test Explorer.
 */
export const probeShellNodePath = (
  shell: string,
): Promise<string | undefined> =>
  new Promise((resolve) => {
    const script = `node --version >/dev/null 2>&1; echo ${START_TOKEN}; command -v node; echo ${END_TOKEN}`;
    const child = spawn(shell, ['-i', '-c', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: SHELL_PROBE_TIMEOUT_MS,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', () => resolve(undefined));
    child.on('close', () => {
      const start = output.indexOf(START_TOKEN);
      const end = output.indexOf(END_TOKEN);
      if (start === -1 || end === -1) {
        resolve(undefined);
        return;
      }
      const found = output.slice(start + START_TOKEN.length, end).trim();
      // A bare name means the shell resolved `node` to something that is not a
      // path; spawning it would only retry PATH.
      resolve(found === '' || !found.startsWith('/') ? undefined : found);
    });
  });

/** `undefined` when the probe could not produce a usable version at all. */
const versionIfUsable = (probe: NodeProbe): string | undefined =>
  probe.kind === 'ok' ? probe.version : undefined;

const satisfiesFloor = (probe: NodeProbe): boolean =>
  probe.kind === 'ok' &&
  checkVersion(probe.version, NODE_RUNTIME_RANGE).kind !== 'mismatch';

export type ResolveWorkerNodeOptions = {
  /** The user's shell, for the interactive probe. Omit to skip that step. */
  readonly shell?: string;
  readonly probe?: (executable: string) => Promise<NodeProbe>;
  readonly probeShellPath?: (shell: string) => Promise<string | undefined>;
  readonly platform?: NodeJS.Platform;
  /** Called once, only when the shell candidate had to stand in for PATH. */
  readonly notify?: (message: string) => void;
};

/**
 * Picks the executable for a test worker. Callers holding an explicit
 * `nodeExecutable` setting must not call this at all — an explicit choice is
 * honored verbatim, unchecked, because it is the escape hatch for everything
 * this function can get wrong.
 *
 * Throws `NodePreflightError` when no candidate satisfies the floor.
 */
export async function resolveWorkerNode({
  shell,
  probe = probeNodeVersion,
  probeShellPath = probeShellNodePath,
  platform = process.platform,
}: ResolveWorkerNodeOptions = {}): Promise<WorkerNodeResolution> {
  let onPath = await probe('node');
  for (
    let attempt = 0;
    attempt < NOT_FOUND_RETRIES && onPath.kind === 'not-found';
    attempt++
  ) {
    await delay(NOT_FOUND_RETRY_DELAY_MS);
    onPath = await probe('node');
  }
  if (satisfiesFloor(onPath)) {
    return {
      executable: 'node',
      source: 'path',
      version: versionIfUsable(onPath),
    };
  }

  // Upstream Vitest skips the shell probe on Windows: there is no `-i -c`
  // equivalent that reliably evaluates a user's profile across cmd/PowerShell.
  const shellSkipped = platform === 'win32' || shell === undefined;
  let fromShell: string | undefined;
  if (!shellSkipped) {
    const shellPath = await probeShellPath(shell);
    if (shellPath !== undefined) {
      const probed = await probe(shellPath);
      if (satisfiesFloor(probed)) {
        return {
          executable: shellPath,
          source: 'shell',
          version: versionIfUsable(probed),
        };
      }
      fromShell = versionIfUsable(probed);
    }
  }
  throw new NodePreflightError({
    path: versionIfUsable(onPath),
    shell: fromShell,
    shellSkipped,
  });
}

/**
 * The resolution is a property of the extension host, not of a project: there
 * is one PATH and one shell, so a monorepo with N projects must not run N
 * identical probes — nor announce the outcome N times, which is why `notify` is
 * called from inside the memo and only on the pass that actually probes. The
 * shell probe in particular costs a whole interactive shell startup.
 *
 * The rejection is memoized too, so a pathological host pays the probe timeouts
 * once rather than once per project.
 *
 * `shell` and `notify` are options rather than imported singletons so this
 * module stays free of any one stack's — and of VS Code's — globals, which is
 * also what lets the tests drive it as a pure decision table. See the note in
 * AGENTS.md before moving it to `shared/`.
 */
let cached: Promise<WorkerNodeResolution> | undefined;

export const resolveWorkerNodeOnce = (
  options: ResolveWorkerNodeOptions = {},
): Promise<WorkerNodeResolution> =>
  (cached ??= resolveWorkerNode(options).then((resolution) => {
    if (resolution.source === 'shell') {
      options.notify?.(
        `Node.js on the extension host PATH cannot run tests (needs ${NODE_RUNTIME_RANGE}); using ${resolution.executable}${
          resolution.version ? ` (${resolution.version})` : ''
        } from your shell instead`,
      );
    }
    return resolution;
  }));

export const resetWorkerNodeCache = (): void => {
  cached = undefined;
};
