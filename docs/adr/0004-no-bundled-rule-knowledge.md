---
status: accepted
---

# Self-documenting diagnostics carry no bundled rule knowledge

Issue #27 wants Rslint diagnostics to explain themselves in the editor: hover over rule ids in inline directives, clickable rule ids in the Problems panel, faded/struck-through rendering for dead-code rules. The Go server today gives the client almost nothing to build on: `textDocument/publishDiagnostics` sets only range, severity, source and a message of the form `[rule-id] description` — no `code`, no `codeDescription`, no `tags` — the server advertises no `hoverProvider`, exposes no rule-metadata request, and the rule type itself has no description field. The tempting fix is to bundle what the server won't say: a rule list (there are ~500), per-rule descriptions scraped from the docs site, a hand-maintained set of "unused-variable-like" rules for `DiagnosticTag.Unnecessary`.

**Decision.** The extension carries **no per-rule data of any kind**. Everything it shows is either **derived from the rule id by one formula** — `https://rslint.rs/rules/<plugin prefix minus '@', or 'eslint' for core rules>/<rule-name>`, the same formula as upstream's `getRuleDocUrl` — or **parsed from server output**: the lint middleware reads the `[rule-id] ` prefix off each published diagnostic's message, synthesizes `code` + `codeDescription.href`, and strips the prefix (if the message doesn't match, the diagnostic passes through untouched). No network requests either: links are best-effort, so a mistyped or brand-new rule id yields a dead docs link, not a validation round-trip.

## Considered options

- **Bundle rule metadata** (scrape `rslint.rs/llms.txt` or vendor the per-rule `.md` files at build time) — rejected: a standing sync pipeline whose failure mode is showing _stale_ descriptions, worse than showing none; the docs link already lands on the authoritative text.
- **Validate links over the network** (HEAD-check with cache, suppress hover on 404) — rejected: makes an editor affordance depend on connectivity; offline/intranet kills the feature.

## Consequences

- Hover and Problems-panel entries show the rule id and its docs link, **no prose description**, until upstream exposes rule metadata.
- A mistyped rule id in an inline directive stays **silent** — the extension cannot know it is unknown without a rule list. The user's signal is the squiggle the directive failed to suppress. Proper reporting (unused/mistyped directive diagnostics) is upstream work.
- `DiagnosticTag` rendering is **not attempted client-side** — only rules know whether they are dead-code-like, and encoding that in the extension is exactly the bundled knowledge this ADR forbids.
- The message-prefix synthesis is **transitional by design**: once the Go server publishes `code`/`codeDescription` natively, the middleware synthesis is deleted, not kept as a fallback. If upstream changes the message format first, the guard makes the feature degrade to the status quo silently.
- The client-side hover provider registers only while the server does not advertise `hoverProvider`; the day it does, the client yields (the fmt precedent: never fight a server-registered capability).
