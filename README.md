# Rstack Editor

<p>
  <a href="https://github.com/rstackjs/rstack-editor/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/rstackjs/rstack-editor/ci.yml?branch=main&style=flat-square&colorA=564341&colorB=EDED91" alt="CI status" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=rstack.rstack"><img src="https://vsmarketplacebadges.dev/version/rstack.rstack.svg?style=flat-square&label=VS%20Marketplace&labelColor=564341&color=EDED91" alt="VS Marketplace version" /></a>
  <a href="https://open-vsx.org/extension/rstack/rstack"><img src="https://img.shields.io/open-vsx/v/rstack/rstack?style=flat-square&label=Open%20VSX&colorA=564341&colorB=EDED91" alt="Open VSX version" /></a>
  <a href="https://github.com/rstackjs/rstack-editor/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square&colorA=564341&colorB=EDED91" alt="license" /></a>
</p>

Rstack Editor provides unified editor support for [Rstack](https://rstack.rs), the fast, unified JavaScript toolchain for developers and agents. It integrates [Rslint](https://github.com/web-infra-dev/rslint), [Rstest](https://github.com/web-infra-dev/rstest) and [rstack-cli](https://github.com/rstackjs/rstack-cli) into a single extension, so one install covers the whole toolchain.

> [!IMPORTANT]
>
> **Work in progress.** Rstack Editor is pre-1.0 and under active development. Settings, command ids and behavior can change between releases. Bug reports and feedback are very welcome.

## Install

| Registry | Editors | Version | Installs |
| --- | --- | --- | --- |
| [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=rstack.rstack) | VS Code | [![VS Marketplace version](https://vsmarketplacebadges.dev/version-short/rstack.rstack.svg?style=flat-square&label=version&labelColor=564341&color=EDED91)](https://marketplace.visualstudio.com/items?itemName=rstack.rstack) | [![VS Marketplace installs](https://vsmarketplacebadges.dev/installs-short/rstack.rstack.svg?style=flat-square&labelColor=564341&color=EDED91)](https://marketplace.visualstudio.com/items?itemName=rstack.rstack) |
| [Open VSX Registry](https://open-vsx.org/extension/rstack/rstack) | Cursor, Trae, VSCodium, and other VS Code forks | [![Open VSX version](https://img.shields.io/open-vsx/v/rstack/rstack?style=flat-square&label=version&colorA=564341&colorB=EDED91)](https://open-vsx.org/extension/rstack/rstack) | [![Open VSX downloads](https://img.shields.io/open-vsx/dt/rstack/rstack?style=flat-square&label=downloads&colorA=564341&colorB=EDED91)](https://open-vsx.org/extension/rstack/rstack) |

Or search for `rstack.rstack` in the editor's Extensions view.

## Documentation

- [VS Code extension](./packages/vscode/README.md) — installation, features, detection and settings
- [Rstack](https://rstack.rs) · [Rslint](https://rslint.rs) · [Rstest](https://rstest.rs) — the tools the extension integrates

## Packages

| Name | Description |
| --- | --- |
| [`packages/vscode`](./packages/vscode) | The VS Code extension (`rstack.rstack`) |

## Contributing

Contributions are welcome! Please read the [Contributing Guide](./CONTRIBUTING.md) for setup, workflow and release details.

## License

Rstack Editor is licensed under the [MIT License](./LICENSE).
