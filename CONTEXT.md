# Ubiquitous language

Glossary of terms used across rstack-editor. Code, docs, commit messages and reviews use these words with exactly these meanings.

## Core

- **Stack** — one tool integration (lint, test, fmt) hosted by the extension shell. A stack registers against the shell and reports status through it; stacks never own UI chrome.
- **Shell** — the always-activating extension core: detection, status bar, output channels, stack lifecycle.
- **Detection** — the per-workspace-folder scan deciding which stacks a folder lights up. Detection signals are config files and installed tool binaries, never user settings.
- **Gate** — the per-stack activation condition: detected, workspace trusted, and the enable settings on.

## Runtimes

- **VS Code Node runtime** — the Node.js shipped inside VS Code, which the extension host itself runs on. Its version follows VS Code's release cadence, and it is Electron's Node, on a different ABI line from plain Node. _Avoid_: host runtime, extension host runtime.
- **User Node runtime** — the Node.js the user's own environment provides, discovered by the extension rather than shipped with it. _Avoid_: worker runtime, project-side Node.
- **Load bound** — the limit on what a piece of work can end up loading: what the extension ships, plus ABI-stable N-API bindings. Work that stays inside the bound may run on the VS Code Node runtime; work that can load project code has no load bound and belongs on a User Node runtime. _Avoid_: load surface.
- **Preflight** — the check that picks a User Node runtime, run once per extension host and shared by every process that loads project code (the lint worker, the test worker, the fmt server). Its failure is a status, never a crash.
- **Runtime floor** — the version range a User Node runtime must satisfy (`NODE_RUNTIME_RANGE` in `shared/versionCheck.ts`). A declared support contract, not a probed capability.

## Tools and configs

- **Atomic tool** — a single Rstack tool used standalone (Rstest, Rslint). Each atomic tool's CLI reads only its own native config and has no knowledge of the Rstack config. _Avoid_: standalone tool, raw tool.
- **Native config** — the config file an atomic tool reads by itself (`rstest.config.*`, `rslint.config.*`). _Avoid_: tool config, own config.
- **Rstack config** — the unified `rstack.config.*` file consumed by rstack-cli (`rs`), holding per-tool sections. Tools never read it themselves; `rs` hands each tool its section through a shim.
- **Shim** — the module rstack-cli ships per tool that loads the Rstack config and exposes that tool's section through the tool's ordinary explicit-config channel. The extension points upstream machinery at the shim rather than re-implementing Rstack config semantics.
- **Bridged project** — a test project the extension synthesizes for a directory whose test signal is a Rstack config, wired to the shim. _Avoid_: virtual project, rstack project.
- **Config root** — the directory a tool's config is loaded from, which is also the directory the tool's process stands in. For the fmt server the editor anchors it at the workspace folder root, so it loads the config a terminal opened on that folder would, and a subproject that needs its own config becomes its own workspace folder. The test stack does not share this anchor: a project's cwd is set per project (for native configs, upstream's config-file-directory rule). _Avoid_: config directory, project root.
- **Ownership** — the editor-side rule choosing one config source for a tool's unit of work when both a native config and a Rstack config are present: the atomic tool's native config wins and the bridge yields. The unit is the tool's own — a project for test (one per config directory), a workspace folder for lint (one config choice per folder, locked for each lint runtime's lifetime). This rule exists only in the editor; upstream CLIs never face the choice, since each reads only its own config.

## lint

- **Rslint core** — one `@rslint/core` package directory, identified by its real path (two copies of the same version are two cores; a symlink to one copy is that copy). Everything a lint runtime runs — the Go binary, config host, protocol version, plugin host — derives from one Rslint core. _Avoid_: core (bare), installation, binary.
- **Lint runtime** — the lint machinery serving one Rslint core inside one workspace folder: one lint worker, the Go process it spawns, and one language client. Unrelated to the Node runtimes above. _Avoid_: server, instance, coordinator.
- **Lint worker** — the process the extension ships and runs for one lint server: it hosts Rslint's JS side (config evaluation, plugin rules) on a User Node runtime with its cwd at the workspace folder root, and fronts the Go `rslint --lsp` process it spawns, so the editor sees one language server. _Avoid_: lint host, lint proxy, lint server (that is what the worker presents, not what it is).
- **Bridged folder** — a workspace folder whose lint runs against the Rstack config: no native `rslint.config.*` anywhere in the folder, a `rstack.config.*` at its root, and the lint worker pinned to rstack's shipped shim for its whole lifetime. _Avoid_: bridged workspace, rstack folder.
- **Native folder** — a workspace folder whose lint runs against its own `rslint.config.*`, exactly as the standalone Rslint extension would.
- **Inline directive** — a source comment that toggles lint rules for a scope: `rslint-disable`, `rslint-enable`, `rslint-disable-line`, `rslint-disable-next-line`, with the `eslint-` prefix accepted as an exact equivalent. Rule ids are comma-separated; a bare directive applies to all rules. _Avoid_: disable comment, suppression comment.
- **Rule docs link** — the documentation URL derived from a rule id alone (one base URL plus the id, no per-rule data). Best-effort by design: a mistyped or brand-new rule id yields a dead link, never an error. _Avoid_: rule doc URL, docs href.

## fmt

- **Fmt server** — the `rs fmt` language server the extension runs for one workspace folder, and the only thing that formats documents in it. It loads that folder's config root once and holds it for its lifetime, so a config change is a **restart** of the server, never a message to it. _Avoid_: formatter daemon, fmt worker.
- **Fmt folder set** — the workspace folders that currently have a fmt server, kept in step with detection: a newly detected folder gains one, a folder that loses detection loses its own, and a folder in both sets keeps the server it already has.
