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
  // An object code means the language client converted a server-published
  // codeDescription into the authoritative value/target shape. This synthesis
  // then yields automatically and becomes dead code to delete (ADR 0004).
  if (typeof diagnostic.code === 'object') return;

  const match = RULE_PREFIX.exec(diagnostic.message);
  if (!match) return;

  const code = diagnostic.code ?? match[1];
  // The language client has already converted LSP diagnostics here. VS Code's
  // equivalent of LSP code + codeDescription is the value/target code shape.
  diagnostic.code = {
    value: code,
    target: ruleDocsUri(String(code)),
  };
  diagnostic.message = diagnostic.message.slice(match[0].length);
}
