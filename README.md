# Rstack Editor

Rstack Editor provides unified editor support for [Rstack](https://rstack.rs), the fast, unified JavaScript toolchain for developers and agents. It integrates [Rslint](https://github.com/web-infra-dev/rslint), [Rstest](https://github.com/web-infra-dev/rstest) and [rstack-cli](https://github.com/rstackjs/rstack-cli) into a single extension, so one install covers the whole toolchain.

> [!IMPORTANT]
>
> **Work in progress.** Rstack Editor is pre-1.0 and under active development. Settings, command ids and behavior can change between releases, and not every config source is wired up yet — see the roadmap below for what works today. Bug reports and feedback are very welcome.

## Packages

| Name | Description |
| --- | --- |
| [`packages/vscode`](./packages/vscode) | The VS Code extension (`rstack.rstack`) |

## Roadmap

The extension takes its configuration from five sources. The tool-native configs are fully supported today; support for driving a stack from `rstack.config.*` is landing one stack at a time.

| Config source | Status |
| --- | --- |
| `rslint.config.*` | **Supported.** Diagnostics, quick fixes and the language server, all resolved from the `@rslint/core` installed in your project. |
| `rstest.config.*` | **Supported.** Test discovery, run and debug, watch mode, coverage and snapshot updates in the Test Explorer. |
| `define.test()` in `rstack.config.*` | **Supported.** Tests run through the same config shim `rs test` uses, so the editor and the CLI resolve the config identically. |
| `define.fmt()` in `rstack.config.*` | **Supported.** Document formatting through the project-local `rs fmt` language server (`rs fmt --lsp`), one per workspace folder, loading the config from the folder root — the same config `rs fmt` run there would use. Needs `rstack` 0.5.2 or newer. |
| `define.lint()` in `rstack.config.*` | **Supported, with requirements.** A workspace folder with no `rslint.config.*` anywhere and an `rstack.config.*` at its root is linted from `define.lint()`, evaluated through rstack's own config loader so the editor and `rs lint` see the same config. It needs `@rslint/core` installed in the project — `rstack` depends on it, but pnpm does not expose transitive dependencies, so add it to your `devDependencies` — and new enough to let the editor pin the language server to a config; until both hold, the status bar says which one is missing. A TypeScript `rstack.config.ts` additionally needs a VS Code build whose Node can strip types, since rstack's config loader has no fallback. A folder that does have an `rslint.config.*` keeps using it, unchanged. |

## License

Rstack Editor is licensed under the [MIT License](./LICENSE).
