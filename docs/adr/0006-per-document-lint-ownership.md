---
status: accepted
---

# Lint ownership follows the document's ancestor chain

ADR 0003 wrote lint ownership down as a workspace-folder decision: any `rslint.config.*` anywhere in the folder made the whole folder native, and only a folder with none could be bridged to a root `rstack.config.*`. That wording pinned ownership to the editor's folder, which is narrower than the rule it meant to state — a config governs the directory tree below it — and the implementation followed the wording. Issue #85 shows the gap. A root `rstack.config.*` with `define.lint()` stops working as soon as one subdirectory adds its own `rslint.config.*`: every file in the folder goes to the native Go server, the files outside that subdirectory fall outside every config boundary, and they get no diagnostics while the status bar still says `running`.

The constraint ADR 0003 cited is real but does not force the folder granularity. Rslint's server locks its config choice per **process** (`internal/lsp/server.go`: "Changing that choice requires a new process"), not per folder. Since the rslint #1617 sync, `RuntimeManager` resolves a runtime per document and keys it on `folder + core identity + shim`, so one folder can already run a bridged runtime and a native runtime side by side. The folder-level decision was the only thing preventing it.

**Decision.** Ownership is decided per document, from the configs on the document's own ancestor chain (`decideDocumentMode` in `stacks/lint/resolution.ts`). Walking up from the document's directory:

1. The first `rslint.config.*` between the document's directory and the workspace folder root, both included → **native**.
2. Otherwise, a `rstack.config.*` at the folder root → **bridged** (rstack → `@rslint/core` from rstack's directory, shim pinned, as in ADR 0003).
3. Otherwise, the nearest `rslint.config.*` above the folder, skipping `node_modules` and counting only while `@rslint/core` resolves from the folder (#89) → **native**.
4. Otherwise the lint stack does not serve the document: no `didOpen`, no diagnostics.

A sibling or descendant config never counts. A root `rslint.config.*` beside a root `rstack.config.*` still makes every document native, by rule 1. Detection stays per folder and only collects the signals; there is no folder mode any more.

Rule 4 matches the `rslint` CLI, which lints only files inside some config's boundary: run at the root of a tree whose only config is `packages/legacy/rslint.config.ts`, it lints the two files under `packages/legacy` and never touches `src/index.ts`.

## Considered options

**Keep folder ownership and document the limitation** — leaves #85 as is: a mixed repository gets silent gaps with a healthy status. Rejected.

**Let the root `rstack.config.*` win whenever it exists** — breaks the documents a nested `rslint.config.*` is meant to govern, and contradicts the `rslint` CLI run in that subdirectory. Rejected.

**Per-document ownership over the whole folder's configs** (any config in the folder counts, nearest by distance) — a sibling directory's config would decide documents it can never govern in either CLI. Rejected in favour of the ancestor chain.

## Consequences

- **One folder, several runtimes of both modes.** A bridged and a native runtime can serve one folder at once. A new `rslint.config.*` in a subdirectory changes the detection signature; the reconcile moves only the documents under it to a native runtime, and the bridged runtime keeps serving the other documents without a restart (`e2e/lint/suite-document-ownership`).
- **Known divergence from `rs lint`.** `rs lint` run at the folder root lints nested files with the root Rstack config. The editor lints a file under `packages/legacy/rslint.config.ts` with that config instead. The editor cannot match both CLIs; the nearest config matches the CLI a user runs in that directory (`rslint` in `packages/legacy`), and it is what the native config's author asked for. Accepted.
- **Documents outside every config are not linted.** Before, a folder with a nested config handed every document to the native server, which linted nothing outside that config anyway; now the editor does not open them on a server at all, as the CLI does not lint them.
- **Detection reads every `rslint.config.*`.** The folder's native config list is now an ownership input rather than a detection signal, so its `findFiles` is unbounded like the Rstack config list.
- ADR 0003's "Ownership is per folder, native wins" consequence is superseded. Its other consequences (resolution chains, refresh vs restart, failure states) are unchanged; a native ↔ bridged flip still replaces the runtime, now for the documents that flipped only.
