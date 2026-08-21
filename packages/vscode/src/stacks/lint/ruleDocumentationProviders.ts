import vscode from 'vscode';
import {
  parseInlineDirectiveRuleTokens,
  type InlineDirectiveRuleToken,
} from './inlineDirectives';
import { ruleDocsUrl } from './ruleDocumentation';
import { isSupportedWorkspaceDocument } from './WorkspaceDocumentRouter';

// Registration selector only — runtime eligibility checks go through the
// router's `isSupportedWorkspaceDocument`. Keep this list in step with
// `SUPPORTED_LANGUAGE_IDS` in WorkspaceDocumentRouter.ts (not exported there).
const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
].map((language) => ({ language, scheme: 'file' }));

export interface RuleDocumentationProviderOptions {
  readonly servesDocument: (document: vscode.TextDocument) => boolean;
  readonly serverAdvertisesHover: (document: vscode.TextDocument) => boolean;
  /** Extra moments to recompute decorations (e.g. a detection change). */
  readonly refreshOn?: vscode.Event<unknown>;
}

function tokenRange(
  document: vscode.TextDocument,
  token: { readonly start: number; readonly end: number },
): vscode.Range {
  return new vscode.Range(
    document.positionAt(token.start),
    document.positionAt(token.end),
  );
}

// Hover, document links and decorations all consume the same token list per
// document; the memo makes one edit cost one parse regardless of consumer.
const tokenCache = new WeakMap<
  vscode.TextDocument,
  { version: number; tokens: readonly InlineDirectiveRuleToken[] }
>();
function directiveTokens(
  document: vscode.TextDocument,
): readonly InlineDirectiveRuleToken[] {
  const cached = tokenCache.get(document);
  if (cached?.version === document.version) return cached.tokens;
  const tokens = parseInlineDirectiveRuleTokens(document.getText());
  tokenCache.set(document, { version: document.version, tokens });
  return tokens;
}

/** Registers the Inline-directive affordances owned by the lint stack. */
export function registerRuleDocumentationProviders(
  options: RuleDocumentationProviderOptions,
): vscode.Disposable[] {
  const hoverProvider: vscode.HoverProvider = {
    provideHover(document, position, token) {
      if (
        token.isCancellationRequested ||
        !options.servesDocument(document) ||
        options.serverAdvertisesHover(document)
      ) {
        return undefined;
      }

      const offset = document.offsetAt(position);
      const rule = directiveTokens(document).find(
        (candidate) => candidate.start <= offset && offset < candidate.end,
      );
      if (!rule) return undefined;

      // The shape VS Code renders for the published diagnostics —
      // `Rslint(rule-id)` with the rule id linking to its docs page.
      return new vscode.Hover(
        new vscode.MarkdownString(
          `Rslint([${rule.ruleId}](${ruleDocsUrl(rule.ruleId)}))`,
        ),
        tokenRange(document, rule),
      );
    },
  };

  const documentLinkProvider: vscode.DocumentLinkProvider = {
    provideDocumentLinks(document, token) {
      if (token.isCancellationRequested || !options.servesDocument(document)) {
        return [];
      }
      return directiveTokens(document).map(
        (rule) =>
          new vscode.DocumentLink(
            tokenRange(document, rule),
            vscode.Uri.parse(ruleDocsUrl(rule.ruleId)),
          ),
      );
    },
  };

  // A persistent underline marks each rule id as an affordance (hover /
  // ctrl+click); the DocumentLink underline alone only shows while the
  // modifier key is held.
  const decorationType = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline',
  });

  const decorate = (editor: vscode.TextEditor): void => {
    const document = editor.document;
    const eligible =
      isSupportedWorkspaceDocument(document) &&
      options.servesDocument(document);
    editor.setDecorations(
      decorationType,
      eligible
        ? directiveTokens(document).map((rule) => tokenRange(document, rule))
        : [],
    );
  };
  const decorateVisibleEditors = (): void => {
    for (const editor of vscode.window.visibleTextEditors) decorate(editor);
  };
  // One trailing-edge debounce across all triggers. It also keeps the initial
  // pass off the awaited register() path (adaptation 1: register returns fast).
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const scheduleDecorate = (): void => {
    clearTimeout(debounce);
    debounce = setTimeout(decorateVisibleEditors, 100);
  };
  scheduleDecorate();

  return [
    vscode.languages.registerHoverProvider(DOCUMENT_SELECTOR, hoverProvider),
    vscode.languages.registerDocumentLinkProvider(
      DOCUMENT_SELECTOR,
      documentLinkProvider,
    ),
    decorationType,
    vscode.window.onDidChangeVisibleTextEditors(scheduleDecorate),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (
        vscode.window.visibleTextEditors.some(
          (editor) => editor.document === event.document,
        )
      ) {
        scheduleDecorate();
      }
    }),
    ...(options.refreshOn ? [options.refreshOn(scheduleDecorate)] : []),
    { dispose: () => clearTimeout(debounce) },
  ];
}
