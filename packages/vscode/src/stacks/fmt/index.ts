import path from 'node:path';
import vscode from 'vscode';
import {
  findPackageJsonUncached,
  readPackageJson,
} from '../../shared/packageResolve';
import {
  readPackageVersion,
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
 * Spawn-per-request formatter backed by the project-resolved rstack CLI. The
 * process cwd selects the nearest governing rstack config because `rs fmt`
 * intentionally performs cwd-only config resolution.
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

  async register(context: StackContext): Promise<Record<string, unknown>> {
    this.#context = context;
    this.#snapshot = context.detection;
    const provider: vscode.DocumentFormattingEditProvider = {
      provideDocumentFormattingEdits: (document, _options, token) =>
        this.provideDocumentFormattingEdits(document, token),
    };
    this.#subscriptions.push(
      context.onDidChangeDetection((snapshot) => {
        this.#snapshot = snapshot;
        this.#loggedOnce.clear();
      }),
      vscode.languages.registerDocumentFormattingEditProvider(
        SELECTOR,
        provider,
      ),
    );
    this.reportRunning(context, context.detection);
    return { languages: LANGUAGE_IDS, provider };
  }

  /** `running` always carries the reason the stack is on: where it was detected. */
  private reportRunning(
    context: StackContext,
    snapshot: DetectionSnapshot,
  ): void {
    const names = snapshot.foldersFor('fmt').map((entry) => entry.folder.name);
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

    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
      return [];
    }
    const fmtDetection = snapshot.forFolder(folder)?.stacks.fmt;
    if (!fmtDetection?.detected) {
      // The formatter is offered per language, so a request can land in a
      // folder without an rstack setup. That is routine, not a fault — one
      // info line per folder says why nothing happened.
      if (!this.#loggedOnce.has(`undetected:${folder.uri.toString()}`)) {
        this.#loggedOnce.add(`undetected:${folder.uri.toString()}`);
        context.output.info(
          `A format request in ${folder.name} was skipped: fmt is not detected there (no rstack.config.* and no rstack CLI at the folder root)`,
        );
      }
      return [];
    }

    const cwd = pickConfigDir(
      document.uri.fsPath,
      fmtDetection.rstackConfigFiles.map((uri) => uri.fsPath),
      folder.uri.fsPath,
    );
    // Per-request logging follows prettier-vscode's shape (same in-host,
    // work-per-request architecture): a fixed entry and outcome line at info,
    // resolution detail at debug — the channel is a LogOutputChannel, so the
    // user raises the level from its context menu when needed.
    const startedAt = Date.now();
    context.output.info(`Formatting ${document.uri.fsPath}`);
    const pkgJsonPath = findPackageJsonUncached('rstack', cwd);
    if (!pkgJsonPath) {
      const reason = `rstack is not installed in ${folder.name} (node_modules missing)`;
      context.status.report({ kind: 'disabled', reason });
      if (!this.#loggedOnce.has(`missing:${cwd}`)) {
        this.#loggedOnce.add(`missing:${cwd}`);
        context.output.warn(`${reason}; searched from ${cwd}`);
      }
      return [];
    }

    if (
      !reportVersionCheck(
        context.status,
        'rstack',
        readPackageVersion(pkgJsonPath),
      )
    ) {
      return [];
    }

    const pkg = readPackageJson(pkgJsonPath);
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
    const rsBinJs = path.resolve(path.dirname(pkgJsonPath), binEntry);
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

    let result;
    try {
      result = await runRsFmt({
        text,
        filePath: document.uri.fsPath,
        cwd,
        rsBinJs,
        signal: requestController.signal,
      });
    } finally {
      cancellation.dispose();
      this.#abortController.signal.removeEventListener('abort', abortRequest);
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
        this.reportRunning(context, snapshot);
        const edit = minimalEdit(text, result.formatted);
        context.output.info(
          `Formatting completed in ${elapsed}ms${edit ? '' : ' (already formatted)'}`,
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
    for (const subscription of this.#subscriptions.splice(0)) {
      subscription.dispose();
    }
    this.#loggedOnce.clear();
    this.#context = undefined;
    this.#snapshot = undefined;
  }
}

export const createFmtController = (): StackController => new FmtController();
