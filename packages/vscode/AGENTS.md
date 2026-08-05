# AGENTS.md — `rstack.rstack` VS Code extension

One extension replacing the standalone `rstack.rslint` and `rstack.rstest` extensions: a thin shell (activation, detection, status bar, settings migration) hosting one stack per tool under `src/stacks/`.

## The copies are intentional

- `stacks/lint` and `stacks/test` are deliberate near-verbatim copies of the upstream extensions, kept close to upstream so changes can be synced by diffing. Do NOT deduplicate or refactor across the two stacks — the duplication is the point; consolidation is a later, explicit phase.
- The copies diverge from upstream in exactly five ways (the "adaptations" below). When syncing upstream, preserve them. A sixth divergence is either a bug or must be added to this list.

## The five adaptations

1. **Shell activation** — stacks never self-activate; `register()` returns fast and never blocks on starting a server/worker.
2. **Namespace** — everything user-visible is `rstack.*`. Legacy `rslint.*` / `rstest.*` names appear only in the migration mapping. Command IDs were renamed without aliases (breaking old keybindings was an accepted cost).
3. **Resolve-from-project** — no tool binaries or tool packages in the VSIX; everything resolves from the user's project so the editor runs the CLI's exact versions. Version floors surface as a status, never a crash. All cooperating lint pieces (binary, config loader, plugin host) must come from one resolution root.
4. **Status aggregation** — stacks own no UI chrome; they report to the shell's single status bar item, which always exists.
5. **Worker-cwd decoupling** (test) — a project's cwd is explicit, not derived from the config file path; for native configs behavior stays byte-identical to upstream.

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
- The fmt stack is a stub on purpose. The MVP will spawn `rs fmt --stdin-filepath` with cwd = the config directory (forced by rs fmt's cwd-only config resolution); the endgame is an upstream LSP, so do not add a warm-process middle tier or "fix" the stub into an error state.
- The VSIX is platform-targeted for exactly one reason: the test stack's AST collection loads a native parser binding. Do not add another native dependency — it multiplies the release matrix.

## Testing

- E2E suites ported from upstream keep upstream's assertion semantics; every intentional deviation is documented in a comment in the test itself. A failing ported test is a regression, not a test to adjust.
- E2E fixtures install published npm packages (not workspace links): the extension must work against what users actually install. Fixture `node_modules` are disposable and never committed.
- Prefer running the E2E slice that covers the change (`test:e2e:*` scripts; `RSTACK_LINT_E2E_SUITES=<name,...>` filters lint suites) over the full chain.
