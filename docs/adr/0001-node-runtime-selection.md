# Node runtime selection

The Node.js a test worker runs on is a **User Node runtime** — chosen by the extension from the user's own environment, the PATH `node` first and then the `node` the user's interactive shell would give them — and it must satisfy a uniform floor, `^22.18.0 || >=23.6.0`. The **VS Code Node runtime** is never a candidate. When nothing satisfies the floor, the test stack reports a status and runs nothing.

## Why the floor is `^22.18.0 || >=23.6.0`

The strictest thing a worker does is load an `rstack.config.*`, which rstack's shipped shim loads through `@rstackjs/load-config` with `loader: 'native'`. That path rethrows with no jiti fallback (`rstack-cli` `packages/rstack/src/config.ts:174`, bundled verbatim into `rstack@0.4.0`'s `dist/687.js`), and `native` never consults `process.features.typescript` — it calls `import()` directly. So the worker needs Node's native TypeScript stripping, which was unflagged in 23.6.0 and backported to the LTS line in 22.18.0. That release history is why the floor is a disjunction rather than a single version: 23.0–23.5 compare above 22.18.0 yet predate the unflagging, and `^22.18.0 || >=23.6.0` names exactly the versions that strip by default.

Native type stripping is the _only_ thing on the worker's path that needs more than the declared `engines` of the packages involved: `@rstest/core` 0.11.6 and `@rsbuild/core` declare `^20.19.0 || >=22.12.0`, `rstack` 0.4.0 declares `>=22.12.0`, and `Module.registerHooks` (used by rstack's `freshImport`, added in 22.15) has a three-level fallback.

## Considered options

**A per-project floor** — 22.18.0 only for projects driven by an `rstack.config.*`, 22.12.0 for a native `rstest.config.*`. Rejected: it buys back Node 20.19–22.17 at the cost of a second code path through every call site. Node 20 left support on 2026-04-30, so the users it genuinely serves are those on Node 22.12–22.17 — a supported LTS line, needing only a patch-level update within 22.x. That is a low-friction ask, and one uniform floor is a support contract the README and the status bar can each state in one sentence.

**A capability probe instead of a version check** — asking each candidate for `process.features.typescript` rather than comparing semver. Rejected: `process.features.typescript` is itself Stability 1.2 (release candidate) and its value set has moved (`"transform"` existed on 22.18–25.1, removed in 26.0.0). More decisively, `loader: 'native'` never reads it, so the probe would not be testing the condition that actually fails. A floor is a contract; contracts are declared, not sniffed.

**Falling back to the VS Code Node runtime** — using it when no User Node runtime satisfies the floor. Rejected, and this is the load-bearing "no". It is not a version argument; the VS Code Node runtime is new enough. It is that a green run in the editor must mean the same thing as a green run in the terminal. That runtime is Electron's Node, on its own ABI line (measured: `NODE_MODULE_VERSION` 146, against 137 for plain Node 24.18), so a non-N-API addon that loads in the terminal fails in the editor and the reverse — and its version tracks VS Code's release cadence rather than anything the project controls. A degraded success here produces a false signal, which is worse than not running.

**Bun as a User Node runtime** — rejected for now: `bun run` on `@rstest/core` segfaults (verified, bun 1.3.2 × `@rstest/core` 0.11.5), though bun loads `rstack.config.ts` fine.

## Where the shell probe stands

The interactive-shell probe runs with its cwd set to the first detected workspace folder that does not pin `nodeExecutable`. The probe is cwd-sensitive: version managers resolve version files (`.nvmrc`, `.node-version`) against the shell's working directory, and fnm's default `version-file-strategy = local` never walks upward — a shell spawned from the extension host's own cwd (typically `/`) cannot see any project's version file and answers with the manager's global default (measured: a repository pinning 26 in `.nvmrc`, the probe answering with the 20.x global default). Standing in the workspace folder is what makes the probe answer the question it exists to answer: what a terminal opened on this project would say.

The probe stays one-per-host — one PATH, one shell, one interactive start-up cost, and the fallback notice must fire once, not once per project — so one directory has to stand for the whole window. The entry points share the memo, first caller wins: the activation warm-up, almost always first, derives its standpoint and its own reason to exist from one query — the first detected folder without a pinned `nodeExecutable` both proves the memo has a reader (pinned folders never read it) and is where the probe stands; the worker spawn path, first only when the warm-up found every folder pinned, stands in that project's cwd, the directory it is about to run the worker in; a fmt server start (ADR 0002) stands in its own workspace folder root, and gets there first whenever no rstest warm-up preceded it. The folder root rather than a project directory is the deliberate default: version files overwhelmingly sit at the repository root, which in a monorepo is _above_ the package that owns the config.

**Per-project probes** — rejected: N interactive shells for what is in practice a repository-level convention, and a window that genuinely needs a different Node per folder is `nodeExecutable`'s case — that setting is read per folder already.

**Walking upward for `.git` or a version file** — rejected: it re-implements the version manager's own lookup policy. The extension stands where the user's terminal would stand; how the version manager answers from there is the manager's business. A user who opened a subdirectory of their repository probes from that subdirectory — the terminal they would open there answers the same way.

## Where the VS Code Node runtime _is_ allowed

The rule is not "never use it". The line is the **load bound**: work whose loads stay inside what the extension controls (what it ships, plus N-API bindings, ABI-stable by construction) may run on the VS Code Node runtime; work that can load arbitrary project dependencies is unbounded and must run on a User Node runtime. Loading a config is on the wrong side of that line — configs in this ecosystem import native bindings routinely — so config loading stays inside the worker, where the upstream machinery already puts it.

Note that _worker_ names a process, not a runtime. The worker is our own code; the runtime it runs on is the user's.

### Where the line is drawn today

This decision was written for one path, the rstest worker, and named two others that sat on the wrong side of the line. One of them has since moved:

- **fmt** used to spawn the project's `rs` bin on `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (`stacks/fmt/run.ts`) — the VS Code Node runtime — and let `rs fmt` load the project's config in that process: unbounded load, no floor, no preflight. It now runs `rs fmt --lsp` as a language server on a User Node runtime chosen by this decision's own logic, against the same floor, with the shared `rstack.nodeExecutable` as its escape hatch. Why the server, and why one per workspace folder: `docs/adr/0002-fmt-lsp-on-user-node-runtime.md`.
- **lint** imports the project's `@rslint/core/config-loader` into the extension host and loads the user's `rslint.config.ts` there (`stacks/lint/configLoader.ts`), and runs user plugin rules on the same runtime (`stacks/lint/PluginLintPool.ts`). `stacks/lint/jitiPreflight.ts` already records the resulting divergence in so many words: that loader "runs on the extension host's Node — whose version is fixed by VS Code, not by the user — so the jiti branch can trigger in the editor even when the CLI works fine". Its answer is a diagnostic, not a runtime choice.

Lint is what moving costs when it is not cheap: fmt's move needed a whole upstream language server to exist first, and lint needs its own spawn-and-protocol work for the config loader and the plugin host, with no reported bug behind it yet. It stays known debt, deliberately — the rule is not universal until that entry is gone, and nobody should describe it as if it were.

## Consequences

- An explicit `rstack.nodeExecutable` (shipped as `rstack.rstest.nodeExecutable` when this was written, shared with the fmt server since ADR 0002 and migrated for existing users) is always honoured, but it is probed too: falling short of the floor produces a status, not a refusal. The escape hatch stays an escape hatch; it stops being silent.
- A below-floor configured executable is reported through the same status as "no runtime found at all", so the two messages must state their _consequence_ explicitly — one says tests will not run, the other says the extension is running with it anyway.
- The interactive-shell probe is the recovery path and does not exist on Windows (no `-i -c` equivalent reliably evaluates a user's profile across cmd and PowerShell). A Windows user whose PATH `node` is below the floor gets the failure status with no second candidate.
- `NODE_OPTIONS` can carry `--no-strip-types`, which defeats the floor on any version. Deliberately not detected: the same setting breaks `rs test` in the terminal, so the editor failing identically is correct, and special-casing one flag would be permanent trivia bought for one diagnostic.
- An unreadable or unparseable `node --version` is treated as _not_ satisfying the floor, unlike the package checks in `shared/versionCheck.ts`, which soft-pass an unknown version. The difference is real: runtime candidates are an ordered list, so a soft pass lets a suspect PATH `node` beat a healthy one from the shell; a package check has no next candidate to fall through to.
