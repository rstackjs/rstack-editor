# Ticket: lint through an editor-shipped worker; bridge `define.lint()` from `rstack.config.*`

Implements `docs/adr/0003-lint-through-editor-worker.md` (accepted). Read that ADR, `CONTEXT.md` (Ownership, Lint worker, Bridged folder, Native folder) and `packages/vscode/AGENTS.md` first. Terms below are the glossary's.

## Outcome

- A **bridged folder** (no `rslint.config.*` anywhere in the workspace folder, a `rstack.config.*` at its root) lints from `define.lint()`, through rstack's own shipped shim, with the same diagnostics `rs lint` prints in a terminal.
- A **native folder** keeps linting exactly as today from the user's point of view (ported E2E suites stay green with their assertion semantics), but its config evaluation and plugin rules now run in the **lint worker** on a User Node runtime, not in the extension host.
- No project code is imported into the extension host by the lint stack any more.

## Non-goals

- No generated shim, no editor-side interpretation of the Rstack config (never read `configs.lint`, never call `loadRstackConfig` from the extension). The only Rstack artefact the editor touches is the path `<rstack package dir>/dist/rslintConfig.js`, treated as stable.
- No `rs lint --lsp`, no rslint upstream change. The worker is written vscode-free so it can move to `@rslint/core` later; do not add editor coupling to it.
- No sync of rslint #1617's per-document runtime model — issue #13. Keep `WorkspaceRslintCoordinator` per folder.
- No `configPath`-style user setting.

## Facts the implementer needs (verified 2026-08-18)

**rslint protocol (Go side, `@rslint/core` 0.8.0, rslint PR #1630)** — `internal/lsp/config_discovery.go`:

- `rslint/configRefresh` request `{protocolVersion: 2, reason, configPath?}`. `reason` of the first refresh must be `'initial'`. `configPath` is an absolute **native** path (no `file:` URI), extension `.js/.mjs/.cjs/.ts/.mts/.cts`. Once the first refresh has decided (present or absent), the choice is **locked for the process** — a later refresh that changes it errors with `InvalidParams`; changing mode = new process.
- Explicit mode: Go loads exactly that module, keeps the **spawn cwd** as the matching root (`files`/`ignores`/`parserOptions.project`), skips `rslint.json` fallback, and stops watching ancestor JS configs — **the client owns change notifications for the explicit path** (`architecture.md` ~L785). Its `.gitignore` watcher stays.
- Reverse requests Go sends its client: `rslint/loadConfigs`, `rslint/activateConfigs`, `rslint/commitConfigs`, `rslint/abortConfigs`, `rslint/pluginLint`. Handlers must be registered before the first refresh.
- The Go binary is `@rslint/native-*`; the CLI/LSP takes only `--lsp`; argv is otherwise ignored.

**`@rslint/core` 0.8.0 exports** (`./config-loader`): `ConfigModuleHost`, `CONFIG_DISCOVERY_PROTOCOL_VERSION` (=2), `resolveRslintBinary()`, protocol types; (`./eslint-plugin`): `createPluginLintHost`. Upstream's `CoreResolver.ts` derives everything from one core directory this way.

**rstack** (`0.6.1`, depends on `@rslint/core ~0.8.0`; `0.5.2` still `~0.7.3`): `rs lint` = `runCLI({argv:[..., '--config', join(import.meta.dirname, 'rslintConfig.js')]})`. `dist/rslintConfig.js` = `loadRstackConfig()` → `configs.lint ?? []` → call if function → default export. `loadRstackConfig()` with no args reads the CLI's `globalThis.__rstackCliState.configPath` else searches `process.cwd()` for `rstack.config.{ts,js,mts,mjs}` via `@rstackjs/load-config` `loader:'native'`, `fresh:true`. `dist/*` is not in `exports`; locate the package via its `package.json`.

**Our code today** (`packages/vscode/src`): spawn at `stacks/lint/Rslint.ts:630-642` (`LanguageServerProcessOwner(binPath, ['--lsp'], folderRoot)`), reverse handlers `Rslint.ts:732-783`, refresh `Rslint.ts:957-961`, watch glob `Rslint.ts:126`; JS host pieces `configLoader.ts`, `ConfigTransactionAdapter.ts`, `PluginLintPool.ts`, `projectModules.ts`, `jitiPreflight.ts`; resolution `stacks/lint/resolution.ts`; detection `detection.ts:176-212`; floors `shared/versionCheck.ts:27-31`, protocol set `:154`; User Node selection `shared/nodeResolution.ts` (+ `USER_NODE_STACKS` in `extension.ts:34`, `nodeExecutableSetting.ts`); fmt's spawn-on-User-Node reference `stacks/fmt/index.ts:329-371, 429`; the rstest worker bundling pattern `rslib.config.mts:44-110`; settings `package.json` "Rstack › Rslint" block; migration mapping tests `tests/migration.test.ts:186-192, 362`.

## Work breakdown

1. **Lint worker** (`src/stacks/lint/worker/`, own rslib entry like the rstest worker; CJS, `target: node`, no `vscode` import).
   - CLI: `--lsp --core <absolute @rslint/core dir> [--config <absolute module>]`. Anything else is a usage error.
   - Load `<core>/config-loader` and `<core>/eslint-plugin` (ESM `import()` from the core dir; mirror upstream `CoreResolver.ts` structural checks). Binary = that core's `resolveRslintBinary()`; spawn it with `--lsp`, cwd = `process.cwd()`, stdio pipes.
   - Proxy JSON-RPC between `process.stdin/stdout` (extension) and the Go child (vscode-jsonrpc star handlers both ways, cancellation and ids preserved). Own the Go child's lifetime (SIGTERM → SIGKILL, exit when either side closes).
   - Answer Go's five reverse requests locally: port `LspConfigTransactionAdapter` + `PluginLintPool` + fingerprinting logic into the worker with their behaviour intact (`loadMode:'fresh'` forcing, generation grace, protocol validation, cancellation → AbortSignal).
   - Intercept the extension's `rslint/configRefresh {reason}`: stamp `protocolVersion` from the core and, when started with `--config`, the same `configPath` every time; forward to Go; return Go's response.
   - Log to stderr only; stdout is the LSP channel.
2. **Extension-side lint stack** (`Rslint.ts` keeps the language-client half only).
   - Resolution (`resolution.ts`, pure, unit-tested): native folder → `@rslint/core` from the folder root; bridged folder → `rstack` from the folder root, then `@rslint/core` from rstack's directory (`createRequire`-style, physical `node_modules`, no PnP); `rstack.rslint.corePath` overrides the core hop in both modes. Result: `{ mode, coreDir, coreVersion, rstackDir?, rstackVersion?, shimPath? }`. Gates: `@rslint/core >= 0.8.0`; bridged additionally `rstack >= 0.6.1` (raise `SUPPORT_MATRIX` — `rstack: '>=0.6.1'`, `'@rslint/core': '>=0.8.0'`; delete `SUPPORTED_CONFIG_DISCOVERY_PROTOCOL_VERSIONS` and the protocol-mismatch classes/messages).
   - Runtime: pick the User Node through `resolveUserNodeOnce` with lint's own consequence sentence; add `'rslint'` to `USER_NODE_STACKS`; honour `rstack.nodeExecutable`. Spawn `<node> <worker.js> --lsp --core <dir> [--config <shim>]` via `LanguageServerProcessOwner`, cwd = folder root.
   - Delete from the extension host: `configLoader.ts`, `ConfigTransactionAdapter.ts`, `PluginLintPool.ts`, `projectModules.ts`, `jitiPreflight.ts` (they move to the worker or die), and `shared/vendored/loadRstackConfig.ts` if nothing else imports it. Remove every `TODO(rstack-bridge)` marker.
   - Refresh: keep the watcher-driven `requestConfigRefresh` (send `{reason}` only). Bridged folder: watch glob adds the root `rstack.config.{ts,js,mts,mjs}` (mind: no nested brace groups). Mode flip (a native config appearing/disappearing, root rstack config appearing/disappearing) restarts through the coordinator's replacement path.
   - Status: bridged folder — no `rstack` → `disabled`; `rstack`/chained `@rslint/core` below floor or no Node clearing the floor → `version mismatch` (message names package + required version, or the shared preflight message + lint consequence); worker/Go dies → `crashed`. Native folder missing `@rslint/core` stays `crashed`.
3. **Detection** (`detection.ts`): `rslint.detected = rslintConfigFiles.length > 0 || rootRstackConfigExists`; expose which (mode) so the stack does not re-scan; presence only, never contents. Update `tests/lintDetection.test.ts`, `tests/detection.test.ts`, `e2e/suite/detection.test.ts` (the rstack row now lights all three stacks).
4. **Settings/migration**: remove `rstack.rslint.binPath`, `rstack.rslint.customBinPath` (and `rslint.customBinPath` from the migration mapping + tests); add `rstack.rslint.corePath` (string, resource-scoped, description mirroring upstream); `restartOnSettings = ['corePath', 'trace.server']`. README (user-facing) settings table updated.
5. **Docs**: `packages/vscode/AGENTS.md` — adaptation #7 (lint worker + bridge), rewrite the "bridge was built and deliberately removed" gotcha, drop "Lint still loads project code on the VS Code Node runtime" from adaptation #6, add worker gotchas (vscode-free; explicit paths only; refresh vs restart line). `docs/adr/0001-node-runtime-selection.md`: move lint from the debt list to "retired by ADR 0003". Root `README.md`/`packages/vscode/README.md` only if user-facing behaviour is described there.
6. **Tests**:
   - Unit: resolution chain + mode decision + status classification as pure modules; worker CLI parsing / configRefresh stamping with a fake Go (spawn a small stdio JSON-RPC stub).
   - E2E: bump fixtures to `rstack@0.6.1`, `@rslint/core@^0.8.0`; `e2e/fixtures/rstack/rstack.config.ts` already carries `define.lint([...no-debugger...])` — add a lint bridge suite (diagnostic from that rule in a folder with no `rslint.config.*`, a `rstack.config.ts` edit refreshing it, a native config appearing flipping the folder). All ported lint suites (`e2e/lint/suite*`) must pass unchanged in assertion semantics. Add the slice to `SLICES` if a new entry is needed.

## Verification (report real output)

- `pnpm lint && pnpm test:unit`
- `VSCODE_CLI=1 pnpm test:e2e lint vscode smoke` (lint slice = ported suites + bridge; `vscode` = detection; `smoke` uses the rslint fixture — update if it imports the removed in-host plugin host path)
- Manual: open `packages/vscode/e2e/fixtures/rstack` alone in the Extension Development Host; expect a `no-debugger` diagnostic and status `running`; delete `rstack` from `node_modules` → `disabled`.

## Guardrails

- Never delete `packages/vscode/.vscode-test/`.
- Fixture `node_modules` are disposable, never committed.
- Do not reintroduce a per-request child, a generated file, or any Rstack-config semantics in the extension.
- Do not add native dependencies to the VSIX.
