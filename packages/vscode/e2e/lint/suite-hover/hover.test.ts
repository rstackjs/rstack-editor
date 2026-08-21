import * as assert from 'node:assert';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  diagnosticRuleIdIncludes,
  waitForRslintDiagnostics,
} from '../utils/diagnostics';
import { waitForLintStackRegistration } from '../utils/extension';

const RULE_ID = 'no-console';
const RULE_DOCS_LINK = 'https://rslint.rs/rules/eslint/no-console';

suite('Rslint self-documenting diagnostics', function () {
  this.timeout(90_000);

  async function openFixture(): Promise<vscode.TextDocument> {
    await waitForLintStackRegistration(true);
    const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const document = await vscode.workspace.openTextDocument(
      path.join(workspaceRoot, 'src', 'index.ts'),
    );
    await vscode.window.showTextDocument(document);
    return document;
  }

  /** Position just inside the first occurrence of `text` in the document. */
  function positionInside(
    document: vscode.TextDocument,
    text: string,
  ): vscode.Position {
    const offset = document.getText().indexOf(text);
    assert.ok(offset >= 0, `The fixture must contain "${text}"`);
    return document.positionAt(offset + 1);
  }

  async function hoverTextAt(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<string> {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      position,
    );
    return (hovers ?? [])
      .flatMap((hover) => hover.contents)
      .map((value) => (typeof value === 'string' ? value : value.value))
      .join('\n');
  }

  test('shows the Rule docs link when hovering an Inline-directive rule id', async () => {
    const document = await openFixture();
    const content = await hoverTextAt(
      document,
      positionInside(document, RULE_ID),
    );

    // The diagnostic-matching shape: `Rslint(rule-id)`, rule id linking out.
    assert.ok(
      content.includes(`Rslint([${RULE_ID}](${RULE_DOCS_LINK}))`),
      `Hover did not render Rslint(${RULE_ID}) with the docs link: ${content}`,
    );
  });

  test('hovers a prefixed rule id on a mid-file Inline directive', async () => {
    const document = await openFixture();
    const ruleId = 'local/no-null';
    const content = await hoverTextAt(
      document,
      positionInside(document, ruleId),
    );

    assert.ok(
      content.includes(ruleId),
      `Hover did not name ${ruleId}: "${content}"`,
    );
    assert.ok(
      content.includes('https://rslint.rs/rules/local/no-null'),
      `Hover did not contain the derived docs link: "${content}"`,
    );
  });

  test('renders Inline-directive rule ids as document links', async () => {
    const document = await openFixture();
    const ruleStart = document.getText().indexOf(RULE_ID);
    assert.ok(ruleStart >= 0, 'The fixture must contain the rule id');

    const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
      'vscode.executeLinkProvider',
      document.uri,
    );
    const ruleLink = (links ?? []).find(
      (link) => link.target?.toString() === RULE_DOCS_LINK,
    );

    assert.ok(ruleLink, `Expected a document link to ${RULE_DOCS_LINK}`);
    assert.deepStrictEqual(
      [ruleLink.range.start, ruleLink.range.end],
      [
        document.positionAt(ruleStart),
        document.positionAt(ruleStart + RULE_ID.length),
      ],
      'The link range must cover exactly the rule id token',
    );
  });

  test('publishes a clickable rule code on diagnostics', async () => {
    const document = await openFixture();
    const diagnostics = await waitForRslintDiagnostics(document, (items) =>
      items.some((diagnostic) => diagnosticRuleIdIncludes(diagnostic, RULE_ID)),
    );
    const diagnostic = diagnostics.find((item) =>
      diagnosticRuleIdIncludes(item, RULE_ID),
    );

    assert.ok(diagnostic, `Expected a ${RULE_ID} diagnostic`);
    assert.ok(
      !diagnostic.message.startsWith(`[${RULE_ID}] `),
      `Diagnostic prefix was not stripped: ${diagnostic.message}`,
    );
    assert.strictEqual(
      typeof diagnostic.code === 'object'
        ? diagnostic.code.target.toString()
        : undefined,
      RULE_DOCS_LINK,
    );
  });
});
