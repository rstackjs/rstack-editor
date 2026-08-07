# Rstack Editor

Rstack Editor provides unified editor support for [Rstack](https://rstack.rs), the fast, unified JavaScript toolchain for developers and agents. It integrates [Rslint](https://github.com/web-infra-dev/rslint), [Rstest](https://github.com/web-infra-dev/rstest) and [rstack-cli](https://github.com/rstackjs/rstack-cli) into a single extension, so one install covers the whole toolchain.

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
| `define.fmt()` in `rstack.config.*` | **Supported.** Document formatting through the project-local `rs fmt --stdin-filepath`, resolving the config the same way the CLI does; an `rs fmt` language server is the longer-term path. |
| `define.lint()` in `rstack.config.*` | **Planned.** Linting a project configured only through `rstack.config.*` needs upstream changes in Rslint and rstack-cli before the editor can evaluate it correctly. `rs lint` on the command line is unaffected. |

## License

Rstack Editor is licensed under the [MIT License](./LICENSE).
