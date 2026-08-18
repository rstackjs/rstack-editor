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

The extension takes its configuration from five sources. Tool-native configs and each supported `define.*()` bridge are available today.

| Config source | Status |
| --- | --- |
| `rslint.config.*` | **Supported.** Diagnostics, quick fixes and the language server, all resolved from the `@rslint/core` installed in your project. |
| `rstest.config.*` | **Supported.** Test discovery, run and debug, watch mode, coverage and snapshot updates in the Test Explorer. |
| `define.test()` in `rstack.config.*` | **Supported.** Tests run through the same config shim `rs test` uses, so the editor and the CLI resolve the config identically. |
| `define.fmt()` in `rstack.config.*` | **Supported.** Document formatting through the project-local `rs fmt` language server (`rs fmt --lsp`), one per workspace folder, loading the config from the folder root — the same config `rs fmt` run there would use. |
| `define.lint()` in `rstack.config.*` | **Supported.** In a folder without a native Rslint config, diagnostics come through rstack's published lint shim — the same config path `rs lint` uses. |

## License

Rstack Editor is licensed under the [MIT License](./LICENSE).
