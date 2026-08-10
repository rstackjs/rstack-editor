# AGENTS.md — `rstack.rstack` VS Code extension

One extension replacing the standalone `rstack.rslint` and `rstack.rstest` extensions: a thin shell (activation, detection, status bar, settings migration) hosting one stack per tool under `src/stacks/`.

## The copies are intentional

- `stacks/lint` and `stacks/test` are deliberate near-verbatim copies of the upstream extensions, kept close to upstream so changes can be synced by diffing. Do NOT deduplicate or refactor across the two stacks — the duplication is the point; consolidation is a later, explicit phase.
- The copies diverge from upstream in exactly six ways (the "adaptations" below). When syncing upstream, preserve them. A seventh divergence is either a bug or must be added to this list.

## The six adaptations

1. **Shell activation** — stacks never self-activate; `register()` returns fast and never blocks on starting a server/worker.
2. **Namespace** — everything user-visible is `rstack.*`. Legacy `rslint.*` / `rstest.*` names appear only in the migration mapping. Command IDs were renamed without aliases (breaking old keybindings was an accepted cost).
3. **Resolve-from-project** — no tool binaries or tool packages in the VSIX; everything resolves from the user's project so the editor runs the CLI's exact versions. Version floors surface as a status, never a crash. All cooperating lint pieces (binary, config loader, plugin host) must come from one resolution root.
4. **Status aggregation** — stacks own no UI chrome; they report to the shell's single status bar item, which always exists.
5. **Worker-cwd decoupling** (test) — a project's cwd is explicit, not derived from the config file path; for native configs behavior stays byte-identical to upstream.
6. **Node runtime selection** (test) — the worker's Node is a **User Node runtime** chosen by the extension against one uniform floor, never assumed from PATH; the recovery path is the user's own shell, and the dividing line is the **load bound** (terms in CONTEXT.md; the full rule and rationale in `docs/adr/0001-node-runtime-selection.md`). Implemented for the rstest worker only — fmt and lint still load project code on the VS Code Node runtime, known debt recorded in the ADR, not an invariant the extension already holds.

## Rules

- One stack failing to register or crashing must never take another stack (or the shell) down.
- The shell always activates; per-folder config detection decides which stacks start, and re-runs on config/lockfile changes without a window reload. Enable-settings are coarse kill switches only.
- Reconciles and restarts share one serialized queue (`enqueue`); a reconcile leaves a live stack alone, so the restart commands are the only path that rebuilds one. Do not add a second queue.
- Restart is a shell concern, not a stack one: `rstack.restart` rebuilds every controller, `rstack.<stack>.restart` rebuilds one. A stack must never register its own restart command — a shallower "bounce the tool's process" restart keeps that controller's stale package resolution and version check, which is the bug the command exists to clear.
- Deprecated `rslint.json` / `rslint.jsonc` are unsupported by decision, not omission — never make them detection signals.
- Never share a child process across stacks: the tools have incompatible cwd semantics (lint LSP anchors on spawn cwd; test worker pins to project root; `rs fmt` resolves config from spawn cwd with no upward walk).
- In Restricted Mode (workspace trust), only the status bar runs — no process spawns, no project code loaded.
- The activation exports exist only for the E2E suites; they are not a stable API and carry no compatibility guarantees.
- Watch-pattern globs must not contain nested brace groups — VS Code's glob parser silently fails on them (regression-tested).

## Gotchas — decisions that look wrong but aren't

- The lint × `rstack.config.*` bridge was built and deliberately removed: a partial editor-side bridge gave wrong results, and a correct one needs upstream work first. `TODO(rstack-bridge)` markers carry the plan. Do not reintroduce a partial bridge.
- The test × `rstack.config.*` bridge stays thin on purpose: it points the upstream machinery at rstack's shipped shim and lets the shim interpret the config inside the worker, same as the CLI. Never re-implement rstack config semantics in the extension.
- The fmt stack is a spawn-per-request `rs fmt --stdin-filepath` MVP. Its cwd is the governing config directory because rs fmt resolves config from cwd only, and formatting errors are log-only by design. A single pre-spawned standby that tracks the active editor (see CONTEXT.md) is the accepted, bounded exception to "no warm tier". Do not grow it into a daemon: no long-lived protocol, no process pool, no cross-request state. The endgame is an upstream LSP; the standby retires with it.
- `projectModules.ts` has no cache-invalidation hook and restart must not grow one. Node's ESM registry is keyed by resolved URL and process-lifetime, so clearing the local memo hands back the identical module object (verified); a `?epoch=` query does reload the entry but relative specifiers inside it do not inherit the query, yielding a fresh entry over stale dependencies. In-place reinstalls under an unchanged path need a window reload — say so, don't fake it.
- The VSIX is platform-targeted for exactly one reason: the test stack's AST collection loads a native parser binding. Do not add another native dependency — it multiplies the release matrix.
- `stacks/test/nodeResolution.ts` takes its shell and its notify callback as options instead of importing `vscode` and the stack's `logger` singleton, unlike its neighbours. That is not stylistic: it keeps `resolveWorkerNode` a pure decision table over its inputs, which is what makes the case-by-case unit tests possible without a `vscode` stub. Move it to `shared/` when a second stack has to run user code on a User Node runtime — but not for a caller that only runs _our_ code on the VS Code Node runtime (fmt, the lint plugin host), which has no candidate to choose between and only needs `nativeTypeStrippingAvailable()`.
- The uniform Node floor deliberately exceeds `@rstest/core`'s own `engines` (`^20.19.0 || >=22.12.0`), because the strictest thing a worker does is load an `rstack.config.*` through rstack's shim, which hardcodes `loader: 'native'` with no jiti fallback and so needs native type stripping (22.18+). Do not specialise the floor per project — that was considered and rejected. Why, and what else was rejected: `docs/adr/0001-node-runtime-selection.md`.
- Bun is not a supported worker runtime (it segfaults running `@rstest/core`). If that is ever revisited, gate it on an explicit setting — never on `bun.lock`, since bun-as-package-manager still runs the `rs` bin through its `#!/usr/bin/env node` shebang.

## Testing

- E2E suites ported from upstream keep upstream's assertion semantics; every intentional deviation is documented in a comment in the test itself. A failing ported test is a regression, not a test to adjust.
- E2E fixtures install published npm packages (not workspace links): the extension must work against what users actually install. Fixture `node_modules` are disposable and never committed.
- Prefer running the E2E slice that covers the change (`test:e2e:*` scripts; `RSTACK_LINT_E2E_SUITES=<name,...>` filters lint suites) over the full chain.
