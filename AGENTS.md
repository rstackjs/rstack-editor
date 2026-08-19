# AGENTS.md

Unified editor support for the [Rstack](https://rstack.rs) toolchain. pnpm workspace; the VS Code extension lives in `packages/vscode` (which has its own AGENTS.md — read it before touching extension code). The layout leaves room for other editors (e.g. Zed) as sibling packages.

## Conventions

- All code, comments, commit messages, PRs and docs are in English, regardless of the conversation language.
- Root scripts either fan out (`pnpm -r run`) or act on the whole workspace at once (`pnpm bump`). Never make a root script reach into one named package's internals — add the script to that package instead.
- READMEs are user-facing only. Contributor/agent material goes in AGENTS.md files, not READMEs.
- Sibling checkouts of rslint / rstest / rstack-cli (`../rslint` etc.) are read-only references. Their working trees may be stale: `git fetch origin` and read via `git show origin/main:<path>`.
- Verify claims about upstream behavior or published packages against the actual source or registry — do not answer from memory.

## Workflow

- Before considering a change done: `pnpm lint && pnpm test:unit` (`lint` runs `rs lint --type-check`, which covers type checking — there is no separate typecheck script).
- If extension source changed, also run the E2E slice covering the change (see `packages/vscode/AGENTS.md`). E2E launches a real VS Code and is the ground truth for editor behavior — unit tests are not a substitute.
- Never delete `packages/vscode/.vscode-test/` — it caches the VS Code download the E2E suites reuse.
- Report real command results only; never claim green without running.
- Releases: never tag or publish by hand — the **Release** workflow does both. See CONTRIBUTING.md → Releasing.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`rstackjs/rstack-editor`), operated via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root, created lazily. See `docs/agents/domain.md`.
