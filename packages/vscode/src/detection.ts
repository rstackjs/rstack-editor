import vscode from 'vscode';
import {
  type DetectionSnapshot,
  type FolderDetection,
  type StackDetection,
  type StackId,
  STACK_IDS,
} from './types';

/**
 * `rstack.config.*` is a config source for Rstest and rs fmt:
 * an rstack-cli user may only have `rstack.config.ts` with `define.test()` /
 * `define.fmt()`.
 *
 * TODO(rstack-bridge): Rslint is deliberately NOT lit by `rstack.config.*` for
 * now — the earlier lint bridge had no complete final data path and was
 * removed. Rebuilding it needs upstream work: rstack publishing an
 * explicit-path config loader plus adapter exports, rslint accepting per-root
 * fallback config candidates on `rslint/configRefresh`, and a generic
 * evaluator-module seam shared by the config host and plugin workers.
 */
export const RSTACK_CONFIG_NAMES = [
  'rstack.config.ts',
  'rstack.config.js',
  'rstack.config.mts',
  'rstack.config.mjs',
] as const;

export const RSTACK_CONFIG_GLOB = '**/rstack.config.{ts,js,mts,mjs}';

/**
 * JSON configs (`rslint.json` / `rslint.jsonc`) are deliberately not detection
 * signals — upstream deprecated them and ships `rslint --init` to migrate.
 */
export const RSLINT_CONFIG_GLOB = '**/rslint.config.{js,mjs,ts,mts}';

export const DEFAULT_RSTEST_CONFIG_GLOBS = [
  '**/rstest.config.{mjs,ts,js,cjs,mts,cts}',
] as const;

/**
 * Lockfiles are watched as a proxy for dependency changes — the pattern Rslint
 * already uses. Watching `node_modules` directly is unreliable (pnpm symlinks)
 * and is not attempted.
 */
export const LOCKFILE_NAMES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
] as const;

const LOCKFILE_NAME_SET: ReadonlySet<string> = new Set(LOCKFILE_NAMES);

const isLockfile = (uri: vscode.Uri): boolean =>
  LOCKFILE_NAME_SET.has(uri.path.slice(uri.path.lastIndexOf('/') + 1));

/** Both bins of the `rstack` package point at the same launcher. */
export const FMT_BIN_NAMES = ['rs', 'rstack'] as const;

const NODE_MODULES_EXCLUDE = '**/node_modules/**';
const MAX_CONFIG_FILES = 100;
const REDETECT_DEBOUNCE_MS = 300;

class Snapshot implements DetectionSnapshot {
  constructor(readonly folders: readonly FolderDetection[]) {}

  isDetected(stack: StackId): boolean {
    return this.folders.some((folder) => folder.stacks[stack].detected);
  }

  foldersFor(stack: StackId): readonly FolderDetection[] {
    return this.folders.filter((folder) => folder.stacks[stack].detected);
  }

  forFolder(folder: vscode.WorkspaceFolder): FolderDetection | undefined {
    const key = folder.uri.toString();
    return this.folders.find((entry) => entry.folder.uri.toString() === key);
  }
}

export const emptySnapshot = (): DetectionSnapshot => new Snapshot([]);

/**
 * The fixed part of the watch table: the config names of the Rslint and Rstack
 * rows plus the lockfiles. A lockfile change can flip the `rs fmt` bin probe
 * and the Rslint/Rstest package resolution, so it counts as a detection input.
 */
export const DETECTION_WATCH_NAMES = [
  'rslint.config.js',
  'rslint.config.mjs',
  'rslint.config.ts',
  'rslint.config.mts',
  ...RSTACK_CONFIG_NAMES,
  ...LOCKFILE_NAMES,
] as const;

/**
 * The patterns every detection-relevant file change is watched through.
 *
 * They stay separate patterns — one `FileSystemWatcher` each — instead of being
 * concatenated into a single glob. VS Code's glob engine does not support
 * nested brace groups: `splitGlobAware` (`src/vs/base/common/glob.ts`) tracks
 * `inBraces` as a boolean, so the first `}` of an inner group closes the outer
 * one and the pattern is split mid-group; the regex `parseRegExp` then builds
 * matches nothing. The Rstest globs are user-configurable arbitrary globs and
 * cannot be folded into the fixed name list, so the only correct shape is one
 * pattern per source.
 */
export const detectionWatchPatterns = (
  rstestGlobs: readonly string[],
): string[] => [
  ...new Set([`**/{${DETECTION_WATCH_NAMES.join(',')}}`, ...rstestGlobs]),
];

const readRstestGlobs = (folder: vscode.WorkspaceFolder): readonly string[] => {
  const configured = vscode.workspace
    .getConfiguration('rstack.rstest', folder.uri)
    .get<unknown>('configFileGlobPattern');
  if (
    Array.isArray(configured) &&
    configured.length > 0 &&
    configured.every((entry) => typeof entry === 'string')
  ) {
    return configured as string[];
  }
  return DEFAULT_RSTEST_CONFIG_GLOBS;
};

const findFiles = async (
  folder: vscode.WorkspaceFolder,
  glob: string,
  // The default cap bounds detection cost for rows that are mere *signals* —
  // the stacks rescan their own configs, so a truncated list still lights
  // them up. Rows whose URI list is consumed as-is pass `undefined`
  // (unbounded): the rstack configs are the sole input to the test stack's
  // bridge sync, where silent truncation would drop whole projects.
  maxResults: number | undefined = MAX_CONFIG_FILES,
): Promise<vscode.Uri[]> =>
  vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, glob),
    NODE_MODULES_EXCLUDE,
    maxResults,
  );

const fileExists = async (uri: vscode.Uri): Promise<boolean> => {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
};

/** Probes `node_modules/.bin/{rs,rstack}` for a project-local rstack CLI. */
const probeFmtBin = async (
  folder: vscode.WorkspaceFolder,
): Promise<string | undefined> => {
  for (const name of FMT_BIN_NAMES) {
    const candidates =
      process.platform === 'win32' ? [`${name}.cmd`, name] : [name];
    for (const candidate of candidates) {
      const uri = vscode.Uri.joinPath(
        folder.uri,
        'node_modules',
        '.bin',
        candidate,
      );
      if (await fileExists(uri)) {
        return uri.fsPath;
      }
    }
  }
  return undefined;
};

export const detectFolder = async (
  folder: vscode.WorkspaceFolder,
): Promise<FolderDetection> => {
  const rstestGlobs = readRstestGlobs(folder);
  const [rstackConfigFiles, rslintConfigFiles, binPath, rstestConfigFiles] =
    await Promise.all([
      findFiles(folder, RSTACK_CONFIG_GLOB, undefined),
      findFiles(folder, RSLINT_CONFIG_GLOB),
      probeFmtBin(folder),
      Promise.all(rstestGlobs.map((glob) => findFiles(folder, glob))).then(
        (matches) => matches.flat(),
      ),
    ] as const);

  const stacks: Record<StackId, StackDetection> = {
    rslint: {
      // TODO(rstack-bridge): `rstack.config.*` deliberately does not light
      // Rslint (see the RSTACK_CONFIG_NAMES doc comment).
      detected: rslintConfigFiles.length > 0,
      configFiles: rslintConfigFiles,
      rstackConfigFiles,
    },
    rstest: {
      detected: rstestConfigFiles.length > 0 || rstackConfigFiles.length > 0,
      configFiles: rstestConfigFiles,
      rstackConfigFiles,
    },
    fmt: {
      detected: rstackConfigFiles.length > 0 || binPath !== undefined,
      configFiles: [],
      rstackConfigFiles,
      binPath,
    },
  };

  return { folder, stacks };
};

const signatureOf = (snapshot: DetectionSnapshot): string =>
  snapshot.folders
    .map((entry) => {
      const stacks = STACK_IDS.map((stack) => {
        const detection = entry.stacks[stack];
        const files = [...detection.configFiles, ...detection.rstackConfigFiles]
          .map((uri) => uri.toString())
          .sort()
          .join(',');
        return `${stack}:${detection.detected ? 1 : 0}:${detection.binPath ?? ''}:${files}`;
      }).join('|');
      return `${entry.folder.uri.toString()}=>${stacks}`;
    })
    .sort()
    .join('\n');

/**
 * Runs detection over every workspace folder and keeps it fresh without a
 * window reload: one `FileSystemWatcher` per folder and watch pattern covers
 * the config globs plus the lockfiles.
 */
export class DetectionService implements vscode.Disposable {
  #snapshot: DetectionSnapshot = emptySnapshot();
  #signature = '';
  // A lockfile change means dependencies changed without necessarily moving
  // any config file or the fmt bin probe, so the discovery signature can come
  // out identical while every project-resolved package (Rslint binary, Rstest
  // core, the rstack shim) may now resolve differently. Such a pass must
  // notify subscribers even when the signature is unchanged, or failed
  // resolutions are never retried until a window reload. Set by the lockfile
  // watcher only — a caller that drives the rebuild itself does not need the
  // event, it already has the fresh snapshot.
  #notifyUnchanged = false;
  #watchers: vscode.Disposable[] = [];
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<DetectionSnapshot> | undefined;
  #rerun = false;
  #disposed = false;

  readonly #emitter = new vscode.EventEmitter<DetectionSnapshot>();
  readonly onDidChange = this.#emitter.event;
  readonly #subscriptions: vscode.Disposable[] = [];

  constructor(private readonly output: vscode.LogOutputChannel) {
    this.#subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.installWatchers();
        this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('rstack.rstest.configFileGlobPattern')) {
          this.installWatchers();
          this.schedule();
        }
      }),
    );
  }

  get snapshot(): DetectionSnapshot {
    return this.#snapshot;
  }

  /** Installs the watchers and runs the first detection pass. */
  async initialize(): Promise<DetectionSnapshot> {
    this.installWatchers();
    return this.refresh();
  }

  async refresh(): Promise<DetectionSnapshot> {
    if (this.#running) {
      // Coalesce concurrent refreshes: one extra pass covers every caller that
      // arrived while the current pass was in flight.
      this.#rerun = true;
      return this.#running;
    }
    this.#running = this.runDetection();
    try {
      return await this.#running;
    } finally {
      this.#running = undefined;
      if (this.#rerun && !this.#disposed) {
        this.#rerun = false;
        void this.refresh();
      }
    }
  }

  private async runDetection(): Promise<DetectionSnapshot> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      // Virtual filesystems cannot host a project-local toolchain.
      (folder) => folder.uri.scheme === 'file',
    );
    // Consumed before the first `await`: a pass that rejects (a folder removed
    // mid-scan, a filesystem provider erroring) must not leave the flag set for
    // an unrelated later pass to act on.
    const notifyUnchanged = this.#notifyUnchanged;
    this.#notifyUnchanged = false;
    const detections = await Promise.all(folders.map(detectFolder));
    const snapshot = new Snapshot(detections);
    const signature = signatureOf(snapshot);
    this.#snapshot = snapshot;
    if (signature !== this.#signature || notifyUnchanged) {
      this.#signature = signature;
      this.log(snapshot);
      if (!this.#disposed) {
        this.#emitter.fire(snapshot);
      }
    }
    return snapshot;
  }

  private log(snapshot: DetectionSnapshot): void {
    if (snapshot.folders.length === 0) {
      this.output.info('Detection: no file-scheme workspace folder is open');
      return;
    }
    for (const entry of snapshot.folders) {
      const detected = STACK_IDS.filter(
        (stack) => entry.stacks[stack].detected,
      );
      this.output.info(
        `Detection: ${entry.folder.name} -> ${
          detected.length > 0 ? detected.join(', ') : 'nothing detected'
        }`,
      );
    }
  }

  private schedule(): void {
    if (this.#debounce) {
      clearTimeout(this.#debounce);
    }
    this.#debounce = setTimeout(() => {
      this.#debounce = undefined;
      void this.refresh();
    }, REDETECT_DEBOUNCE_MS);
  }

  private installWatchers(): void {
    for (const watcher of this.#watchers) {
      watcher.dispose();
    }
    this.#watchers = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') {
        continue;
      }
      const onEvent = (uri: vscode.Uri) => {
        if (isLockfile(uri)) {
          this.#notifyUnchanged = true;
        }
        this.schedule();
      };
      for (const pattern of detectionWatchPatterns(readRstestGlobs(folder))) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder, pattern),
        );
        this.#watchers.push(
          watcher,
          watcher.onDidCreate(onEvent),
          watcher.onDidChange(onEvent),
          watcher.onDidDelete(onEvent),
        );
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#debounce) {
      clearTimeout(this.#debounce);
      this.#debounce = undefined;
    }
    for (const watcher of this.#watchers) {
      watcher.dispose();
    }
    this.#watchers = [];
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#emitter.dispose();
  }
}
