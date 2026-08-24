import type vscode from 'vscode';

/**
 * The three stacks this extension integrates. The ids double as the settings
 * and command namespace segments (`rstack.<stack>.*`) and as the `when` context
 * key segments (`rstack.<stack>.detected`, `rstack.<stack>.active`).
 */
export const STACK_IDS = ['rslint', 'rstest', 'fmt'] as const;

export type StackId = (typeof STACK_IDS)[number];

export const STACK_LABELS: Readonly<Record<StackId, string>> = {
  rslint: 'Rslint',
  rstest: 'Rstest',
  fmt: 'rs fmt',
};

/**
 * The one place a per-stack command id is spelled. Both ends — the shell that
 * registers these and the status bar that links to them — go through here, so
 * a renamed verb cannot leave one side pointing at a command that no longer
 * exists (a dead hover link is not a type error).
 */
export const stackCommand = (
  stack: StackId,
  verb: 'restart' | 'output.focus',
): string => `rstack.${stack}.${verb}`;

/** The `category` every contributed command shares in package.json. */
export const COMMAND_CATEGORY = 'Rstack';

/**
 * The title side of `stackCommand`, spelled once for the same reason: a
 * status that tells the user which command to run has to say what the
 * Command Palette shows (`<category>: <title>`), and a status naming a
 * command that was renamed is not a type error. `tests/extension.test.ts`
 * checks the manifest against this.
 */
export const stackCommandTitle = (stack: StackId, verb: 'restart'): string =>
  `${verb === 'restart' ? 'Restart' : verb} ${STACK_LABELS[stack]}`;

/**
 * Per-stack state machine surfaced by the status bar hover.
 *
 * `disabled` covers every "we deliberately did not start" case: the kill-switch
 * settings, Restricted Mode, and phase-gated stacks. The reason is shown to the
 * user, so it must be a complete sentence fragment.
 */
export type StackState =
  | { readonly kind: 'not-detected' }
  | { readonly kind: 'disabled'; readonly reason?: string }
  | { readonly kind: 'starting'; readonly detail?: string }
  | { readonly kind: 'running'; readonly detail?: string }
  | { readonly kind: 'crashed'; readonly detail: string }
  | { readonly kind: 'version-mismatch'; readonly detail: string };

/**
 * The seam every stack reports through instead of owning a status bar item
 * (the status-aggregation adaptation). The shell aggregates all three
 * reporters into the single status bar item.
 */
export interface StatusReporter {
  readonly stack: StackId;
  report(state: StackState): void;
  starting(detail?: string): void;
  running(detail?: string): void;
  crashed(detail: string): void;
  versionMismatch(detail: string): void;
}

/** What detection found for one stack in one workspace folder. */
export interface StackDetection {
  readonly detected: boolean;
  /** Tool-native config files (`rslint.config.*` / `rstest.config.*`). */
  readonly configFiles: readonly vscode.Uri[];
  /** Rslint's per-folder ownership choice; undefined for other stacks. */
  readonly mode?: 'native' | 'bridged';
  /**
   * `rstack.config.*` files governing this folder. A folder can be detected
   * through these alone, in which case the stack has to go through the rstack
   * shim bridge.
   */
  readonly rstackConfigFiles: readonly vscode.Uri[];
  /** `node_modules/.bin/rs` (or `rstack`), the `rs fmt` bin probe result. */
  readonly binPath?: string;
}

export interface FolderDetection {
  readonly folder: vscode.WorkspaceFolder;
  readonly stacks: Readonly<Record<StackId, StackDetection>>;
}

/** Immutable result of one detection pass over all workspace folders. */
export interface DetectionSnapshot {
  readonly folders: readonly FolderDetection[];
  /** True when at least one folder detected the stack. */
  isDetected(stack: StackId): boolean;
  /** The folders in which the stack was detected, in workspace order. */
  foldersFor(stack: StackId): readonly FolderDetection[];
  /** Detection result for one folder, or `undefined` if it is not watched. */
  forFolder(folder: vscode.WorkspaceFolder): FolderDetection | undefined;
}

/**
 * Everything a stack gets from the shell. A stack must not create its own
 * status bar item or output channel, and must not read `rslint.*`/`rstest.*`
 * settings — the namespace is `rstack.<stack>.*`.
 */
export interface StackContext {
  readonly stack: StackId;
  readonly extensionContext: vscode.ExtensionContext;
  /** The stack's own output channel, one of the four the shell owns. */
  readonly output: vscode.LogOutputChannel;
  readonly status: StatusReporter;
  /** Detection state at registration time. */
  readonly detection: DetectionSnapshot;
  /**
   * Fires when detection changed while the stack stays registered (a folder
   * gained or lost a config file). The shell handles the gate flipping; a stack
   * only has to reconcile its own per-folder runtimes.
   */
  readonly onDidChangeDetection: vscode.Event<DetectionSnapshot>;
}

/**
 * One per stack. `register` is called when the stack passes the gate
 * (`rstack.enable && rstack.<stack>.enable && detected(stack)`)
 * and `dispose` when it stops passing it or the extension deactivates.
 *
 * `register` rejecting is contained by the shell: the failure is
 * reported to the status bar and the other stacks keep running.
 *
 * `register` may return an exports object (e.g. the Rstest stack's live
 * `TestController`). The shell republishes it through the extension's public
 * exports so E2E tests can reach live internals via
 * `extensions.getExtension('rstack.rstack').exports` — the same pattern the
 * upstream extensions used. Return `undefined` to publish nothing.
 */
export interface StackController {
  readonly id: StackId;
  /**
   * Setting names whose change must trigger a rebuild, because their value is
   * consumed once at registration (a resolved binary, a probed Node) and a
   * live controller would keep answering with the stale one. The shell
   * answers with one full restart pass — every stack, not just the declarer.
   * A bare name is relative to the stack's namespace (`rstack.<id>.<name>`);
   * a name starting with `rstack.` is taken as-is, for shared settings like
   * `rstack.nodeExecutable`.
   *
   * Declared as data because restart is the shell's concern: the shell owns the
   * listener and the rebuild, so a stack states *what* moves it, never *how* to
   * move itself. A stack that watches this itself would also have to get the
   * teardown ordering right — a change landing mid-rebuild must not queue a
   * second one — which the shell already handles by iterating live controllers.
   */
  readonly restartOnSettings?: readonly string[];
  register(context: StackContext): Promise<Record<string, unknown> | void>;
  /** Teardown may be asynchronous (stopping a language server, workers). */
  dispose(): void | Promise<void>;
}

/**
 * The extension's public exports (`activate`'s return value). Meant for E2E
 * tests; not a stable API for other extensions.
 */
export interface RstackExtensionExports {
  /** Live exports the stack published at registration; undefined when inactive. */
  getStackExports(stack: StackId): Record<string, unknown> | undefined;
  /**
   * Resolves with the stack's exports once it registers (immediately if it
   * already did). Rejects nothing: a stack that never activates never settles.
   */
  whenStackActive(stack: StackId): Promise<Record<string, unknown>>;
}

export type StackControllerFactory = () => StackController;
