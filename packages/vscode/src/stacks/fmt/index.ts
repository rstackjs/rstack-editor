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
  readonly #warnedCwds = new Set<string>();
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
        this.#warnedCwds.clear();
      }),
      vscode.languages.registerDocumentFormattingEditProvider(
        SELECTOR,
        provider,
      ),
    );
    context.status.running();
    return { languages: LANGUAGE_IDS, provider };
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
    const fmtDetection = folder
      ? snapshot.forFolder(folder)?.stacks.fmt
      : undefined;
    if (!folder || !fmtDetection?.detected) {
      return [];
    }

    const cwd = pickConfigDir(
      document.uri.fsPath,
      fmtDetection.rstackConfigFiles.map((uri) => uri.fsPath),
      folder.uri.fsPath,
    );
    const pkgJsonPath = findPackageJsonUncached('rstack', cwd);
    if (!pkgJsonPath) {
      const reason = `rstack is not installed in ${folder.name} (node_modules missing)`;
      context.status.report({ kind: 'disabled', reason });
      if (!this.#warnedCwds.has(cwd)) {
        this.#warnedCwds.add(cwd);
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
      return [];
    }

    switch (result.kind) {
      case 'ok': {
        context.status.running();
        const edit = minimalEdit(text, result.formatted);
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
      case 'cancelled':
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
    this.#warnedCwds.clear();
    this.#context = undefined;
    this.#snapshot = undefined;
  }
}

export const createFmtController = (): StackController => new FmtController();
