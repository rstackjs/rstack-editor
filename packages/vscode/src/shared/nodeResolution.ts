import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import {
  checkVersion,
  NODE_RUNTIME_LABEL,
  NODE_RUNTIME_RANGE,
} from './versionCheck';

/**
 * Choosing the User Node runtime a stack's project-loading child process runs
 * on (the lint worker, the rstest worker and the `rs fmt --lsp` server).
 *
 * The bare `node` a GUI extension host inherits is a *login-shell* snapshot
 * taken at startup — typically a version manager's global default rather than
 * the version the user's terminal would give them. Measured on one developer
 * machine: login shell `node` was 20.19.4 while the interactive shell was
 * 22.23.1. So "what is on PATH" is not a reliable answer, and asking the user's
 * own shell is the recovery path.
 *
 * The floor (`NODE_RUNTIME_RANGE`, in `shared/versionCheck`) is uniform rather
 * than per-project or per-stack. It is set by the strictest thing any of these
 * children do — load an `rstack.config.*` — and applying it uniformly,
 * including to projects whose config an older engine could load, is a
 * deliberate simplification. It costs Node 20.19–22.17 — but Node 20 left
 * support on 2026-04-30 (`nodejs/Release`), so the users it actually turns away
 * sit on 22.12–22.17, a supported LTS line where the remedy is a patch-level
 * update within 22.x. See `docs/adr/0001-node-runtime-selection.md`.
 *
 * There is deliberately NO fallback to the VS Code Node runtime
 * (`process.execPath` + `ELECTRON_RUN_AS_NODE`). It would silently move the
 * run onto Electron's Node — a different ABI line (measured: Electron
 * reports NODE_MODULE_VERSION 146 where plain Node 24.18 reports 137, so
 * non-N-API addons fail to load) and a version chosen by VS Code's release
 * cadence rather than by the project. A green run has to mean the same thing in
 * the editor as in the terminal.
 */

/**
 * The one spelling of the shared runtime pin's key. The manifest, the two
 * user-facing messages below and every `restartOnSettings` declaration refer
 * to the same setting; this constant is what keeps them from drifting.
 * (Defined here rather than in `nodeExecutableSetting.ts` so the messages can
 * use it without this module gaining a `vscode` import.)
 */
export const NODE_EXECUTABLE_SETTING = 'rstack.nodeExecutable';

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
 * What became of running `<executable> --version`. `ok` carries no version when
 * the output could not be parsed — which does *not* satisfy the floor here (see
 * `satisfiesFloor`). The three cases are a union rather than a boolean plus an
 * optional field so that "not found, but here is a version" is unrepresentable.
 */
export type NodeProbe =
  | { readonly kind: 'ok'; readonly version?: string }
  /** Nothing to execute — the one case worth retrying. */
  | { readonly kind: 'not-found' }
  /** It exists but did not answer: non-zero exit, or hung past the timeout. */
  | { readonly kind: 'unusable' };

export type UserNodeResolution = {
  readonly executable: string;
  /** Which candidate won. Drives the fallback notice, nothing else. */
  readonly source: 'path' | 'shell';
  /**
   * Optional only because `NodeProbe` is: a winning candidate always has a
   * version, since an unreadable one cannot clear the floor.
   */
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
  return `No Node.js ${NODE_RUNTIME_LABEL} is available (${candidates}). Rstack needs it to load TypeScript config files. Install a newer Node.js, or set "${NODE_EXECUTABLE_SETTING}" to one`;
};

/**
 * No candidate satisfied `NODE_RUNTIME_RANGE`.
 *
 * `message` states the facts and the remedy but deliberately no consequence:
 * one preflight serves stacks whose consequences differ ("tests will not run"
 * vs "rs fmt will not format"), and the resolution is memoized host-wide, so
 * the first caller's phrasing must not speak for the others. The consequence
 * is load-bearing, not padding — this message and
 * `formatConfiguredNodeBelowFloor` reach the user through the same
 * `version-mismatch` status, and the outcomes are opposite (nothing runs here,
 * the run goes ahead there). Reporting sites therefore go through
 * `messageWith`, which owns the joining rule, rather than each hand-building
 * the suffix.
 */
export class NodePreflightError extends Error {
  constructor(readonly attempts: NodeAttempts) {
    super(formatNodePreflightFailure(attempts));
    this.name = 'NodePreflightError';
  }

  /**
   * The user-facing message with the reporting stack's consequence attached,
   * e.g. `messageWith('tests will not run')`.
   */
  messageWith(consequence: string): string {
    return `${this.message}; until then ${consequence}.`;
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

/** Bracket the one meaningful line in an interactive shell's noisy stdout. */
export const START_TOKEN = '__RSTACK_NODE_START__';
export const END_TOKEN = '__RSTACK_NODE_END__';

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
 * The probe is cwd-sensitive: version managers resolve version files
 * (`.nvmrc`, `.node-version`) against the shell's working directory, and fnm's
 * default strategy never walks upward — so `cwd` must be the directory a
 * terminal on this project would open in. Left unset, the shell inherits the
 * extension host's cwd (typically `/`), where no project's version file is
 * visible and a version manager answers with its global default. Which
 * directory the callers stand in, and why: "Where the shell probe stands" in
 * `docs/adr/0001-node-runtime-selection.md`.
 *
 * Returns `undefined` on any failure; a shell that hangs on a slow rc file must
 * cost a bounded wait, not the Test Explorer.
 */
export const probeShellNodePath = (
  shell: string,
  cwd?: string,
): Promise<string | undefined> =>
  new Promise((resolve) => {
    const script = `node --version >/dev/null 2>&1; echo ${START_TOKEN}; command -v node; echo ${END_TOKEN}`;
    const child = spawn(shell, ['-i', '-c', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: SHELL_PROBE_TIMEOUT_MS,
      cwd,
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
      // No separator at all means the shell resolved `node` to a function or
      // builtin rather than a path; spawning that would only retry PATH. A
      // *relative* path is legitimate — a relative PATH entry resolves
      // against the shell's own cwd — so it anchors where the shell stood:
      // the given cwd, or this process's own when none was passed, which is
      // where `spawn` put the shell.
      if (!found.includes('/')) {
        resolve(undefined);
        return;
      }
      resolve(path.resolve(cwd ?? '.', found));
    });
  });

/** `undefined` when the probe could not produce a usable version at all. */
const versionIfUsable = (probe: NodeProbe): string | undefined =>
  probe.kind === 'ok' ? probe.version : undefined;

/**
 * Only a version that demonstrably clears the floor counts — an unknown one
 * does not, deliberately diverging from the package checks' soft pass. The
 * whole trade-off is documented at `checkVersion` in `shared/versionCheck`.
 */
const satisfiesFloor = (probe: NodeProbe): boolean =>
  probe.kind === 'ok' &&
  checkVersion(probe.version, NODE_RUNTIME_RANGE).kind === 'ok';

export type ResolveUserNodeOptions = {
  /** The user's shell, for the interactive probe. Omit to skip that step. */
  readonly shell?: string;
  /**
   * Where the shell probe stands — the directory a terminal on this project
   * would open in (see `probeShellNodePath` for why the standpoint decides
   * what a version manager answers). Consumed only by the default
   * `probeShellPath`, so an injected probe replaces the standpoint together
   * with the probing itself and cannot silently drop it.
   */
  readonly cwd?: string;
  readonly probe?: (executable: string) => Promise<NodeProbe>;
  readonly probeShellPath?: (shell: string) => Promise<string | undefined>;
  readonly platform?: NodeJS.Platform;
  /** Called once, only when the shell candidate had to stand in for PATH. */
  readonly notify?: (message: string) => void;
};

/**
 * Picks the executable for a stack's project-loading child process. Callers
 * holding an explicit `rstack.nodeExecutable` setting must not call this at
 * all — an explicit choice is always honored, because it is the escape hatch
 * for everything this function can get wrong. It is still probed, by
 * `configuredNodeBelowFloor`, so that falling short of the floor produces a
 * status rather than silence.
 *
 * Throws `NodePreflightError` when no candidate satisfies the floor.
 */
export async function resolveUserNode({
  shell,
  cwd,
  probe = probeNodeVersion,
  probeShellPath = (probedShell: string) =>
    probeShellNodePath(probedShell, cwd),
  platform = process.platform,
}: ResolveUserNodeOptions = {}): Promise<UserNodeResolution> {
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
 * shell probe in particular costs a whole interactive shell startup. The one
 * per-caller input, `cwd`, is first-caller-wins by the same token: a Node
 * version is in practice a repository-level convention, not a per-project one
 * (ADR 0001, "Where the shell probe stands").
 *
 * The rejection is memoized too, so a pathological host pays the probe timeouts
 * once rather than once per project.
 *
 * `shell` and `notify` are options rather than imported singletons so this
 * module stays free of any one stack's — and of VS Code's — globals, which is
 * also what lets the tests drive it as a pure decision table.
 */
let cached: Promise<UserNodeResolution> | undefined;

export const resolveUserNodeOnce = (
  options: ResolveUserNodeOptions = {},
): Promise<UserNodeResolution> =>
  (cached ??= resolveUserNode(options).then((resolution) => {
    if (resolution.source === 'shell') {
      options.notify?.(
        `Node.js on the extension host PATH does not satisfy ${NODE_RUNTIME_RANGE}; using ${resolution.executable}${
          resolution.version ? ` (${resolution.version})` : ''
        } from your shell instead`,
      );
    }
    return resolution;
  }));

/**
 * An explicitly configured `nodeExecutable` is never refused — it is the escape
 * hatch — but it is not trusted blindly either: a setting written against the
 * Node of two years ago is exactly the failure this module exists to catch, and
 * unprobed it produces a broken worker behind a green status bar.
 *
 * Memoized by resolved executable path because the busiest caller
 * (`RstestApi.resolveWorkerNodeCommand`) runs on every worker spawn — config
 * init, `listTests`, every single run — and a process spawn per spawn is a cost
 * nobody asked for. Keyed by path rather than a single slot so a multi-root
 * window whose folders configure different executables probes each one. The
 * memo holds the verdict rather than the probe, so a cache hit costs nothing
 * beyond the lookup.
 */
const configuredVerdicts = new Map<string, Promise<string | undefined>>();

type ConfiguredNodeOptions = {
  readonly probe?: (executable: string) => Promise<NodeProbe>;
};

/**
 * Says the run is going ahead — the consequence is what tells the two
 * `version-mismatch` messages apart (see `formatNodePreflightFailure`) — and
 * names the version and the setting because editing it is the user's next
 * move.
 */
const formatConfiguredNodeBelowFloor = (
  executable: string,
  version: string | undefined,
): string =>
  `The Node.js set in "${NODE_EXECUTABLE_SETTING}" (${executable}, version ${version ?? 'unknown'}) does not satisfy ${NODE_RUNTIME_LABEL}, which Rstack needs to load TypeScript config files. Rstack is using it anyway because the setting is your explicit choice; point it at a newer Node.js, or clear it to let the extension pick one.`;

/**
 * The message for a configured executable that falls short of the floor, or
 * `undefined` when it clears it.
 *
 * Unlike `resolveUserNodeOnce`, this does *not* raise its own notice from
 * inside the memo. It would have to be the first caller's `notify` that wins,
 * since later callers only see the settled promise — and a warmer that passed
 * none would silence the complaint for the whole session. Reporting stays with
 * the caller, where repetition is already absorbed: the status is a latch keyed
 * by reporting site, so re-reporting the same verdict is a `Map.set` with the
 * same key and value.
 */
export const configuredNodeBelowFloor = (
  executable: string,
  { probe = probeNodeVersion }: ConfiguredNodeOptions = {},
): Promise<string | undefined> => {
  let verdict = configuredVerdicts.get(executable);
  if (verdict === undefined) {
    verdict = probe(executable).then((probed) =>
      satisfiesFloor(probed)
        ? undefined
        : formatConfiguredNodeBelowFloor(executable, versionIfUsable(probed)),
    );
    configuredVerdicts.set(executable, verdict);
  }
  return verdict;
};

/** Clears both memos this module holds — a restart exists to clear stale resolution. */
export const resetUserNodeCaches = (): void => {
  cached = undefined;
  configuredVerdicts.clear();
};
