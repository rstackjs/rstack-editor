import path from 'node:path';
import vscode from 'vscode';
import { RSTACK_CONFIG_GLOB } from '../../detection';
import {
  findPackageJsonUncached,
  readPackageJson,
} from '../../shared/packageResolve';
import {
  checkPackageVersion,
  reportVersionCheck,
} from '../../shared/versionCheck';
import type {
  DetectionSnapshot,
  StackContext,
  StackController,
} from '../../types';
import {
  isRsFmtLaunchError,
  minimalEdit,
  pickConfigDir,
  runRsFmt,
  stderrTail,
} from './run';
import { FmtStandby, type StandbyKey } from './standby';

// prettier 3.9.6 getSupportInfo() vscodeLanguageIds snapshot (rs fmt's pinned
// prettier). Revisit when the pinned prettier changes.
const LANGUAGE_IDS = [
  'ansible',
  'css',
  'dockercompose',
  'github-actions-workflow',
  'graphql',
  'handlebars',
  'home-assistant',
  'html',
  'javascript',
  'javascriptreact',
  'json',
  'json5',
  'jsonc',
  'less',
  'markdown',
  'mdx',
  'mjml',
  'mongo',
  'postcss',
  'scss',
  'typescript',
  'typescriptreact',
  'vue',
  'yaml',
] as const;

const SELECTOR: vscode.DocumentSelector = LANGUAGE_IDS.map((language) => ({
  language,
  scheme: 'file',
}));

/**
 * How long the active editor must hold still before it gets a standby. Arming
 * spawns a process, so scrolling through a dozen tabs must not spawn a dozen
 * children; the first arm at registration and the re-arm right after a consume
 * skip the wait because both target an editor that is already settled.
 */
const ARM_DEBOUNCE_MS = 2_000;

/** Everything a format request needs once the folder has been resolved. */
interface FmtTarget {
  readonly cwd: string;
  readonly rsBinJs: string;
}

const standbyKey = (uri: vscode.Uri, target: FmtTarget): StandbyKey => ({
  cwd: target.cwd,
  filePath: uri.fsPath,
  rsBinJs: target.rsBinJs,
});

/**
 * Resolution outcome, kept free of side effects so the arming path (which must
 * stay silent) and the format path (which reports and logs) can share it.
 */
type FmtResolution =
  | { readonly kind: 'ok'; readonly target: FmtTarget }
  | { readonly kind: 'no-folder' }
  | { readonly kind: 'undetected'; readonly folder: vscode.WorkspaceFolder }
  | {
      readonly kind: 'missing-package';
      readonly folder: vscode.WorkspaceFolder;
      readonly cwd: string;
    }
  | { readonly kind: 'version-mismatch'; readonly version: string | undefined };

/**
 * Formatter backed by the project-resolved rstack CLI. The process cwd selects
 * the nearest governing rstack config because `rs fmt` intentionally performs
 * cwd-only config resolution.
 *
 * A request is served either by consuming the standby (hot) or by spawning a
 * process for it (cold); the two paths differ only in where the process came
 * from.
 */
class FmtController implements StackController {
  readonly id = 'fmt' as const;

  #context: StackContext | undefined;
  #snapshot: DetectionSnapshot | undefined;
  readonly #subscriptions: vscode.Disposable[] = [];
  // One-shot log lines, keyed by `<topic>:<path>`. Cleared when detection
  // changes so a fixed setup gets a fresh explanation.
  readonly #loggedOnce = new Set<string>();
  readonly #abortController = new AbortController();
  #disposed = false;
  #standby: FmtStandby | undefined;
  #armTimer: NodeJS.Timeout | undefined;
  /** E2E-only: how the most recent format request was served. */
  #lastServe: 'hot' | 'cold' | undefined;

  async register(context: StackContext): Promise<Record<string, unknown>> {
    this.#context = context;
    this.#snapshot = context.detection;
    this.#standby = new FmtStandby({
      log: (message) => context.output.debug(message),
    });
    const provider: vscode.DocumentFormattingEditProvider = {
      provideDocumentFormattingEdits: (document, _options, token) =>
        this.provideDocumentFormattingEdits(document, token),
    };
    // `rs fmt` loads the project config while it drains stdin, so a parked
    // process already carries the old config. Detection does not fire on config
    // *content* edits — its signature only tracks which files exist — so the
    // standby needs its own watcher over the same glob.
    // Create and delete already arrive as detection changes (the file set is
    // part of its signature), so this watcher covers only the content edits
    // detection cannot see — the same split `stacks/test/project.ts` uses.
    const configWatcher = vscode.workspace.createFileSystemWatcher(
      RSTACK_CONFIG_GLOB,
      true,
      false,
      true,
    );
    this.#subscriptions.push(
      context.onDidChangeDetection((snapshot) => {
        this.#snapshot = snapshot;
        this.#loggedOnce.clear();
        // The cwd, the resolved bin and the config set can all have moved.
        this.invalidateStandby('detection changed');
        // The reconcile leaves a still-detected controller alone, so the
        // running reason must follow the new snapshot here rather than wait
        // for the next successful format.
        this.reportRunning(context, snapshot);
      }),
      vscode.languages.registerDocumentFormattingEditProvider(
        SELECTOR,
        provider,
      ),
      configWatcher,
      configWatcher.onDidChange((uri) =>
        this.invalidateStandby(`${uri.fsPath} changed`),
      ),
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleArm()),
    );
    this.reportRunning(context, context.detection);
    // The editor the user is already looking at needs no settling wait, but
    // arming spawns a process and `register()` must return fast.
    this.scheduleArm(0);
    return {
      languages: LANGUAGE_IDS,
      provider,
      armedFilePath: (): string | undefined => this.#standby?.armedFilePath,
      lastServe: (): 'hot' | 'cold' | undefined => this.#lastServe,
    };
  }

  /** Kills the standby, then re-arms the active editor through the debounce. */
  private invalidateStandby(reason: string): void {
    this.#standby?.kill(reason);
    this.scheduleArm();
  }

  private scheduleArm(delayMs = ARM_DEBOUNCE_MS): void {
    clearTimeout(this.#armTimer);
    this.#armTimer = setTimeout(() => {
      this.#armTimer = undefined;
      this.armActiveEditor();
    }, delayMs);
  }

  /**
   * Arms a standby for whatever the active editor is *now* — the invariant is
   * "the standby tracks the active editor", so the editor is never captured
   * when the arm was scheduled.
   *
   * Nothing formattable being active leaves the standby alone: a peek at the
   * output panel must not cost the user their warm process. A formattable
   * document that cannot be armed is the other case — the editor really did
   * move on, so the standby goes with it.
   */
  private armActiveEditor(): void {
    const context = this.#context;
    const standby = this.#standby;
    if (!context || !standby) {
      return;
    }
    const document = vscode.window.activeTextEditor?.document;
    // The provider's own selector is the eligibility rule, so the two cannot
    // drift apart.
    if (!document || vscode.languages.match(SELECTOR, document) === 0) {
      return;
    }
    // Every invalidation kills the standby before asking for a re-arm, so an
    // armed standby on this file is still valid — and resolving is synchronous
    // filesystem work that runs on the UI thread.
    if (standby.armedFilePath === document.uri.fsPath) {
      return;
    }
    const resolution = this.resolve(document.uri);
    if (resolution.kind !== 'ok') {
      // Arming is silent: an unresolvable editor only means the next format
      // there is cold, which is exactly what happened before the standby.
      context.output.debug(
        `Standby not armed for ${document.uri.fsPath}: ${resolution.kind}`,
      );
      // The editor still moved to another file, so the previous file's standby
      // no longer tracks it. `arm` would have killed it; there is nothing to
      // arm here, so this path has to.
      standby.kill('the active editor moved to a file that cannot be armed');
      return;
    }
    standby.arm(standbyKey(document.uri, resolution.target));
  }

  /**
   * Where a document's `rs fmt` would run. Pure: it reports no status and logs
   * nothing, because the arming path must not move the status bar.
   */
  private resolve(uri: vscode.Uri): FmtResolution {
    const snapshot = this.#snapshot;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!snapshot || !folder) {
      return { kind: 'no-folder' };
    }
    const fmtDetection = snapshot.forFolder(folder)?.stacks.fmt;
    if (!fmtDetection?.detected) {
      return { kind: 'undetected', folder };
    }

    const cwd = pickConfigDir(
      uri.fsPath,
      fmtDetection.rstackConfigFiles.map((configUri) => configUri.fsPath),
      folder.uri.fsPath,
    );
    const pkgJsonPath = findPackageJsonUncached('rstack', cwd);
    if (!pkgJsonPath) {
      return { kind: 'missing-package', folder, cwd };
    }

    // One read for both the version and the bin entry: `resolve` now runs on
    // the arming path too, and `readPackageJson` re-reads from disk by design.
    const pkg = readPackageJson(pkgJsonPath);
    const version = typeof pkg?.version === 'string' ? pkg.version : undefined;
    if (checkPackageVersion('rstack', version).kind === 'mismatch') {
      // Reporting stays with the caller: the arming path must not move the
      // status bar, and the format path goes through `reportVersionCheck` so
      // the shared contract has one implementation.
      return { kind: 'version-mismatch', version };
    }

    const bin = pkg?.bin;
    let binEntry = 'bin/rs.js';
    if (typeof bin === 'string') {
      binEntry = bin;
    } else if (bin && typeof bin === 'object') {
      const rs = (bin as Record<string, unknown>).rs;
      if (typeof rs === 'string') {
        binEntry = rs;
      }
    }
    return {
      kind: 'ok',
      target: {
        cwd,
        rsBinJs: path.resolve(path.dirname(pkgJsonPath), binEntry),
      },
    };
  }

  /** `running` always carries the reason the stack is on: where it was detected. */
  private reportRunning(
    context: StackContext,
    snapshot: DetectionSnapshot,
  ): void {
    const names = snapshot.foldersFor('fmt').map((entry) => entry.folder.name);
    if (names.length === 0) {
      // Nothing detected means the shell is about to retire this controller;
      // its gate state, not `running`, is the truthful report.
      return;
    }
    context.status.running(
      names.length <= 3
        ? `detected in ${names.join(', ')}`
        : `detected in ${names.length} folders`,
    );
  }

  private async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    const context = this.#context;
    const snapshot = this.#snapshot;
    if (
      this.#disposed ||
      !context ||
      !snapshot ||
      document.uri.scheme !== 'file'
    ) {
      return [];
    }

    const resolution = this.resolve(document.uri);
    if (resolution.kind === 'no-folder') {
      return [];
    }
    if (resolution.kind === 'undetected') {
      // The formatter is offered per language, so a request can land in a
      // folder without an rstack setup. That is routine, not a fault — one
      // info line per folder says why nothing happened.
      const folder = resolution.folder;
      if (!this.#loggedOnce.has(`undetected:${folder.uri.toString()}`)) {
        this.#loggedOnce.add(`undetected:${folder.uri.toString()}`);
        context.output.info(
          `A format request in ${folder.name} was skipped: fmt is not detected there (no rstack.config.* and no rstack CLI at the folder root)`,
        );
      }
      return [];
    }

    // Per-request logging follows prettier-vscode's shape (same in-host,
    // work-per-request architecture): a fixed entry and outcome line at info,
    // resolution detail at debug — the channel is a LogOutputChannel, so the
    // user raises the level from its context menu when needed.
    const startedAt = Date.now();
    context.output.info(`Formatting ${document.uri.fsPath}`);
    if (resolution.kind === 'missing-package') {
      const reason = `rstack is not installed in ${resolution.folder.name} (node_modules missing)`;
      context.status.report({ kind: 'disabled', reason });
      if (!this.#loggedOnce.has(`missing:${resolution.cwd}`)) {
        this.#loggedOnce.add(`missing:${resolution.cwd}`);
        context.output.warn(`${reason}; searched from ${resolution.cwd}`);
      }
      return [];
    }
    if (resolution.kind === 'version-mismatch') {
      reportVersionCheck(context.status, 'rstack', resolution.version);
      return [];
    }

    const { cwd, rsBinJs } = resolution.target;
    context.output.debug(`cwd: ${cwd}; bin: ${rsBinJs}`);

    const text = document.getText();
    const version = document.version;
    const requestController = new AbortController();
    const abortRequest = (): void => requestController.abort();
    const cancellation = token.onCancellationRequested(abortRequest);
    this.#abortController.signal.addEventListener('abort', abortRequest, {
      once: true,
    });
    if (token.isCancellationRequested || this.#abortController.signal.aborted) {
      requestController.abort();
    }

    const key = standbyKey(document.uri, resolution.target);
    // An already-cancelled request must not burn the standby.
    const hot = requestController.signal.aborted
      ? undefined
      : this.#standby?.consume(key, {
          text,
          signal: requestController.signal,
        });
    const serve = hot ? 'hot' : 'cold';
    this.#lastServe = serve;

    let result;
    try {
      result = await (hot ??
        runRsFmt({
          text,
          filePath: document.uri.fsPath,
          cwd,
          rsBinJs,
          signal: requestController.signal,
        }));
    } finally {
      cancellation.dispose();
      this.#abortController.signal.removeEventListener('abort', abortRequest);
      // A standby serves exactly one request, and a real format request is
      // itself proof the active file is worth one — re-arm after cold serves
      // too, so a reaped or crashed standby comes back on the next use
      // instead of leaving the file cold until the editor changes. Scheduled
      // rather than immediate: spawning here would delay the edits the caller
      // is waiting for.
      this.scheduleArm(0);
    }

    if (
      token.isCancellationRequested ||
      document.version !== version ||
      this.#disposed
    ) {
      context.output.debug(
        `Formatting result for ${document.uri.fsPath} discarded (document changed or request cancelled)`,
      );
      return [];
    }

    const elapsed = Date.now() - startedAt;
    if (result.kind === 'ok' || result.kind === 'skipped') {
      // Same tailing as the error path: a chatty warning stream must not land
      // in the log unbounded.
      const stderr = stderrTail(result.stderr);
      if (stderr !== '') {
        context.output.debug(`rs fmt stderr: ${stderr}`);
      }
    }
    switch (result.kind) {
      case 'ok': {
        // The freshest snapshot, not the request's capture: detection may
        // have changed while the format was in flight.
        this.reportRunning(context, this.#snapshot ?? snapshot);
        const edit = minimalEdit(text, result.formatted);
        // The hot/cold marker is the only way to tell from a log whether the
        // measured time included a process start-up.
        context.output.info(
          `Formatting completed in ${elapsed}ms (${serve}${
            edit ? '' : ', already formatted'
          })`,
        );
        if (!edit) {
          return [];
        }
        return [
          vscode.TextEdit.replace(
            new vscode.Range(
              document.positionAt(edit.start),
              document.positionAt(edit.end),
            ),
            edit.newText,
          ),
        ];
      }
      case 'skipped':
        context.output.info(
          `Skipped ${document.uri.fsPath}: rs fmt returned no output (the file is ignored or has no parser)`,
        );
        return [];
      case 'cancelled':
        context.output.debug(`Formatting cancelled for ${document.uri.fsPath}`);
        return [];
      case 'error':
        context.output.error(`rs fmt failed in ${cwd}: ${result.message}`);
        if (isRsFmtLaunchError(result)) {
          context.status.crashed(result.message);
        }
        return [];
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#abortController.abort();
    // Covers `rstack.fmt.restart` (the shell rebuilds the controller) and a
    // workspace losing its trust: neither may leave a process behind.
    clearTimeout(this.#armTimer);
    this.#armTimer = undefined;
    this.#standby?.dispose();
    this.#standby = undefined;
    for (const subscription of this.#subscriptions.splice(0)) {
      subscription.dispose();
    }
    this.#loggedOnce.clear();
    this.#context = undefined;
    this.#snapshot = undefined;
  }
}

export const createFmtController = (): StackController => new FmtController();
