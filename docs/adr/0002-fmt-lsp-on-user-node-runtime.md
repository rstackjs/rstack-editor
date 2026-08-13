# Formatting through the `rs fmt` language server

Document formatting is served by **`rs fmt --lsp`** — one language server per detected workspace folder, spawned with its cwd at the folder root, running on a **User Node runtime** that satisfies the floor ADR 0001 sets (`^22.18.0 || >=23.6.0`). It replaces a spawn-per-request `rs fmt --stdin-filepath` MVP that ran on the VS Code Node runtime and kept one pre-spawned process warm for the active editor. The floor for the project's `rstack` rises to `>=0.5.2`, the first release that ships `--lsp`; older releases surface as `version mismatch` and format nothing.

## Why a server rather than a process per request

`rs fmt --lsp` is a real LSP server over stdio. It advertises exactly two things — `documentFormattingProvider` and full-document text sync — so the client registers the formatting provider from the capability and the stack registers no provider of its own. Every format then costs one request on a live process instead of a Node start-up, which is what the standby existed to hide: a single pre-spawned `rs fmt` armed for the active editor, with its own arm/consume/expire lifecycle, a bounded exception to "no warm tier" that is now unnecessary. The stdin path goes with it: the server formats the in-memory buffer through ordinary `didChange` notifications and carries its own staleness guard.

The server also owns the caching that the old path could not do at all. It loads one config — on the first formatting request, from the workspace root the client reports — and holds it for its process lifetime. That is why a config change is a **restart** of that folder's server: `rs fmt --lsp` in 0.5.2 has no config-change notification and no watcher of its own, and upstream's own guidance is to launch one server per config root and restart it after editing the config.

## Why the folder root, not the deepest config

The old path spawned in the deepest directory holding an `rstack.config.*` above the file being formatted. `rs fmt` loads exactly one config, from its cwd, with no upward walk and no merging — and the config a project documents is the one `define.fmt()` sits in at the repository root, which is where a user runs `rs fmt`. Deepest-config-wins therefore let the editor format a file against a config the terminal would never have chosen: the same class of divergence ADR 0001 rejects a runtime fallback for, arrived at through cwd instead of through Node. It also disagreed with the lint stack, which anchors on the folder root because there is one server per workspace folder and its cwd is that root.

One rule across both stacks now: the workspace folder root is the config root. A project that genuinely needs a different fmt config per subproject adds that subproject as its own workspace folder — the same remedy the lint bridge already gives, and the only one that keeps the editor and a terminal opened in that directory agreeing.

## Why the User Node runtime

The server loads the project's `rstack.config.*` through `@rstackjs/load-config` with `loader: 'native'` — the exact path ADR 0001 analysed to set the worker floor, with no jiti fallback and no `process.features.typescript` consultation. So fmt is not a new case: it is the second caller of the same decision, and it takes the floor, the candidate order (PATH `node`, then the user's interactive shell) and the failure reporting out of the one shared module, `shared/nodeResolution.ts`. The escape hatch is shared too — `rstack.nodeExecutable`, resource-scoped, honoured whenever it is set and probed anyway, advisory-only. A user pinning a Node for one tool means it for the toolchain, so there is one setting rather than one per stack (the retired `rstack.rstest.nodeExecutable` migrates to it).

Falling back to the VS Code Node runtime stays rejected — ADR 0001's load-bearing "no", unchanged. It is worth naming that the old fmt path did exactly that: `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, loading the user's config on Electron's Node, with no floor and no preflight. Moving the server onto a User Node runtime is what takes fmt off that ADR's debt list.

## Considered options

**Keeping `--stdin-filepath` as a fallback for `rstack < 0.5.2`** — rejected: two formatting code paths, of which the fallback is the one nobody exercises, and the two do not fail alike (the stdin path anchored on a directory, the server on a workspace root). A version gate states the requirement once, in a place the status bar can read out, and leaves one path to test.

**A server per config root** — the shape the old `pickConfigDir` implied, now with processes: discover every `rstack.config.*` under the folder and run a server for each. Rejected: it reproduces exactly the editor/terminal divergence above, at a higher price (N long-lived processes and a routing rule per document), and it would be a rule the fmt stack alone holds.

**One server for the whole window** — rejected: the server binds one config root, so a multi-root window would have to elect a folder and silently format the others against a foreign config.

**The VS Code Node runtime** — rejected in ADR 0001 ("Falling back to the VS Code Node runtime"), and the fmt server is squarely on the wrong side of the load bound: it loads arbitrary project code through the config.

**Watching the config and telling the live server** — rejected because there is nothing to tell: 0.5.2 handles `initialize`, the sync notifications, `textDocument/formatting` and `shutdown`/`exit`, and nothing else. Restarting the folder's runtime is the only way to drop its cached config.

## Consequences

- There is no cold path any more, so formatting is briefly unavailable after activation, after a restart and after a config change, while that folder's server starts. A format requested before the client has registered the server's capability finds no formatter for the document; nothing falls back to a fresh process.
- The server advertises document formatting only: no range or selection formatting, no format-on-type, no diagnostics. It also ignores the editor's `FormattingOptions` (tab size, spaces) and the client's language id — the file path picks the parser and the project's config decides the style. An editor setting that disagrees with the project config loses, which is the same answer `rs fmt` gives in a terminal.
- Failures stay per folder and stay statuses: no `rstack` installed is `disabled`, an `rstack` below `0.5.2` is `version mismatch`, no Node clearing the floor is `version mismatch` with fmt's own consequence appended to the shared preflight message ("until then rs fmt will not format"), and only a server that fails to launch or stops on its own is `crashed`. One folder in any of those states does not affect another folder's server, and the stack's single status report is the folder set folded by severity (`crashed` > `version mismatch`, which is also where a running folder's pin advisory ranks > `disabled` > `starting` > `running`; the pure fold lives in `stacks/fmt/status.ts`), so a healthy sibling starting or recovering never overwrites another folder's failure — and the status says `starting`, not `running`, until a server actually formats.
- An `rstack.config.*` create, change or delete restarts the server of the folder that contains it, and only that one; a detection change reconciles the folder set and leaves already-running servers alone. Both are deliberate: a healthy server's cached config is worth keeping.
- The extension now holds one long-lived Node process per detected folder for fmt. Each is owned by the same process owner the lint client uses, so a stop is bounded (SIGTERM, then SIGKILL) and the automatic restart vscode-languageclient performs cannot leave an orphan behind.
