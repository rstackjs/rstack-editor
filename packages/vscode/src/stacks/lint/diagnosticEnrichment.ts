import { Uri, type Diagnostic } from 'vscode';
import { ruleDocsUrl } from './ruleDocumentation';

const RULE_PREFIX = /^\[([^\]\s]+)\] /;

// Rule ids repeat heavily across a publish; the key space is bounded by the
// active rule set, so the cache needs no eviction.
const docsUriCache = new Map<string, Uri>();
function ruleDocsUri(ruleId: string): Uri {
  let uri = docsUriCache.get(ruleId);
  if (!uri) {
    uri = Uri.parse(ruleDocsUrl(ruleId));
    docsUriCache.set(ruleId, uri);
  }
  return uri;
}

/** Enriches the diagnostic shape published by today's Rslint server. */
export function enrichRslintDiagnostic(diagnostic: Diagnostic): void {
  // The day the server publishes `code` itself, its answer is authoritative —
  // this synthesis yields automatically and becomes dead code to delete
  // (ADR 0004), even if the message keeps the `[rule-id] ` prefix.
  if (diagnostic.code !== undefined) return;

  const match = RULE_PREFIX.exec(diagnostic.message);
  if (!match) return;

  const ruleId = match[1];
  // The language client has already converted LSP diagnostics here. VS Code's
  // equivalent of LSP code + codeDescription is the value/target code shape.
  diagnostic.code = {
    value: ruleId,
    target: ruleDocsUri(ruleId),
  };
  diagnostic.message = diagnostic.message.slice(match[0].length);
}
