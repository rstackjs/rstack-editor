# Rstack for VS Code

One extension for the whole [Rstack](https://rstack.rs) toolchain: [Rslint](https://github.com/web-infra-dev/rslint) linting, [Rstest](https://github.com/web-infra-dev/rstest) testing, and [rstack-cli](https://github.com/rstackjs/rstack-cli) support. It replaces the standalone `rstack.rslint` and `rstack.rstest` extensions.

## Installation

- **VS Code**: install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=rstack.rstack)
- **Cursor / Trae / VSCodium**: install from the [Open VSX Registry](https://open-vsx.org/extension/rstack/rstack)

The extension ships no tool binaries: `@rslint/core`, `@rstest/core` and `rstack` are resolved from **your project**, so the editor always runs the same versions as your CLI.

## Features

- **Linting (Rslint)** — diagnostics, quick fixes and auto-fix on save via Rslint's language server, from either a native config or `define.lint()`.
- **Testing (Rstest)** — a Test Explorer tree built from your test files: run or debug individual tests, suites or files; the tree stays in sync as files change; failed tests show up as editor diagnostics.
- **rstack-cli** — document formatting through the project-local `rs fmt` language server, one per workspace folder.
- **One status bar item** — a single `Rstack` entry shows which tools are active in the current workspace and why.

## Detection

The extension activates on startup, then decides **per workspace folder** which tools to start:

| Tool | Started when the folder contains |
| --- | --- |
| Rslint | `rslint.config.{js,mjs,ts,mts}` anywhere in the folder, or `rstack.config.*` at the folder root when no native config exists |
| Rstest | `rstest.config.{mjs,ts,js,cjs,mts,cts}` (configurable) or `rstack.config.*` |
| rstack-cli | `rstack.config.*` or `node_modules/.bin/rs` |

Config files and lockfiles are watched, so detection re-runs without a window reload. When something changes that none of those files record — a reinstall that leaves the lockfile untouched, or a `node_modules` that ends up broken — run **Rstack: Relaunch Extension** from the Command Palette (also on the status bar hover) to tear every tool down and start over. To rebuild a single tool, use **Rstack: Restart Rslint** / **Restart Rstest** / **Restart rs fmt**.

A restart re-resolves every binary and package version and respawns every tool process. Deprecated `rslint.json` / `rslint.jsonc` configs are **not** detection signals — migrate them with `rslint --init`.

## Supported package versions

The project-resolved packages are checked against a support matrix at runtime; a mismatch shows up as the `version mismatch` status bar state.

| Package        | Required  |
| -------------- | --------- |
| `@rslint/core` | `>=0.8.0` |
| `@rstest/core` | `>=0.6.0` |
| `rstack`       | `>=0.6.1` |

`rstack` 0.6.1 and `@rslint/core` 0.8.0 provide the explicit lint config protocol used by the Rstack bridge. Older releases report `version mismatch`.

## Auto-fix on save (Rslint)

To automatically fix lint issues when saving, add this to your VS Code settings (`.vscode/settings.json`):

```json
{
  "editor.codeActionsOnSave": {
    "source.fixAll.rslint": "explicit"
  }
}
```

- `"explicit"` — fix on manual save only (Ctrl+S / Cmd+S) — **recommended**
- `"always"` — fix on every save, including auto-save
- `"never"` — disable auto-fix on save

The generic `source.fixAll` kind is honored too.

## Error Lens compatibility

If you use the Error Lens extension and want to avoid duplicated inline messages for failed tests, add this to your `settings.json`:

```json
{
  "errorLens.excludeBySource": ["rstest"]
}
```

## Settings

All settings live under the unified `rstack.*` namespace. There are no `rslint.*` / `rstest.*` settings any more.

| Setting | Default | Description |
| --- | --- | --- |
| `rstack.enable` | `true` | Master switch for the whole extension. |
| `rstack.nodeExecutable` | — | Node binary used for the processes that load your project: the lint worker, test worker and `rs fmt` language server. Empty means the extension picks one (`PATH` first, then the `node` your interactive shell resolves). |
| `rstack.rslint.enable` | `true` | Enable/disable the Rslint integration. |
| `rstack.rslint.corePath` | — | Path to an `@rslint/core` package directory; relative paths resolve from the workspace folder. |
| `rstack.rslint.trace.server` | `off` | LSP trace level (`off` / `messages` / `verbose`). |
| `rstack.rstest.enable` | `true` | Enable/disable the Rstest integration. |
| `rstack.rstest.configFileGlobPattern` | `["**/rstest.config.{mjs,ts,js,cjs,mts,cts}"]` | Glob patterns used to discover config files. |
| `rstack.rstest.testCaseCollectMethod` | `ast` | `ast` (fast) or `runtime` (supports dynamic test generation). |
| `rstack.rstest.applyDiagnostic` | `true` | Show diagnostics in the editor and Problems panel for failures. |
| `rstack.rstest.rstestPackagePath` | — | Explicit `@rstest/core` `package.json`, last-resort override. |
| `rstack.rstest.nodeExecArgs` | `[]` | Extra Node args for the test worker. |
| `rstack.rstest.nodeEnv` | `null` | Extra env for the test worker. |
| `rstack.rstest.debugNodeEnv` | `null` | Extra env when debugging tests. |
| `rstack.rstest.debugExclude` | `["<node_internals>/**"]` | Debug `skipFiles`. |
| `rstack.rstest.debugOutFiles` | `[]` | Debug `outFiles`. |
| `rstack.rstest.debuggerPort` | — | Debugger port. |
| `rstack.rstest.debuggerAddress` | — | Debugger address. |
| `rstack.rstest.terminalShellPath` | — | Shell used by **Run in Terminal**. |
| `rstack.rstest.terminalShellArgs` | `[]` | Shell args for **Run in Terminal**. |
| `rstack.fmt.enable` | `true` | Enable/disable the formatter integration. |

To use `rs fmt` as the formatter for supported documents, opt in through your VS Code settings: `"editor.defaultFormatter": "rstack.rstack"`. The extension never changes `editor.defaultFormatter` itself.

Formatting runs one `rs fmt` language server per workspace folder, which loads `define.fmt()` from the `rstack.config.*` at the **folder root** — the same config `rs fmt` in a terminal there would use, so a config in a subdirectory is not picked up (open that subdirectory as its own workspace folder if it needs different settings). Editing the config restarts the server for you. Your editor's own formatting options (tab size, spaces) are not consulted: the project config decides, exactly as on the command line.

## Migrating from the standalone extensions

Run **Rstack: Migrate Rslint/Rstest Settings** from the Command Palette (it is also offered once, dismissibly, when legacy keys are found).

- Settings are migrated per layer (User, Workspace, Workspace Folder), and the legacy keys are removed after they are copied. Workspace and folder layers touch files inside your repository, so nothing is written before you confirm the previewed key mapping.
- Legacy `rslint.binPath` / `rslint.customBinPath` values are left untouched: a standalone binary path cannot be translated safely into the `@rslint/core` directory the worker requires.
- **Keybindings are not migrated.** Command ids were renamed to `rstack.*` with no aliases, and VS Code has no keybindings API, so any keybinding bound to an old `rslint.*` / `rstest.*` command id has to be re-bound by hand.
- Projects with only `rslint.json` / `rslint.jsonc` are reported as `not detected`; run `rslint --init` to migrate to a JS/TS config.

## Community

- [GitHub](https://github.com/rstackjs/rstack-editor) — report bugs and request features
- [Discord](https://discord.gg/uPSudkun2b) — chat with the team and community

## License

[MIT](https://github.com/rstackjs/rstack-editor/blob/main/LICENSE)
