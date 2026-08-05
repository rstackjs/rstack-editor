# Contributing

Thanks for your interest in contributing to Rstack Editor!

## Setup

- Node.js: the version is pinned in [`.nvmrc`](./.nvmrc) (`nvm use` / `fnm use`). Node >= 22.12 is required.
- pnpm: pinned via the `packageManager` field — run `corepack enable pnpm` once and the right version is used automatically.

```bash
pnpm install   # also installs the git hooks (rs setup)
```

## Development

| Command | What it does |
| --- | --- |
| `pnpm build` | Build every package |
| `pnpm lint` | Lint + type check (`rs lint --type-check`) |
| `pnpm fmt` | Format the repo (`rs fmt`) |
| `pnpm test:unit` | Unit tests |
| `pnpm test:e2e` | Full E2E chain (installs fixtures, launches a real VS Code) |

To try the extension: press F5 in VS Code at the repo root — the playground launch config starts a watch build, lets you pick a fixture project, and opens an Extension Development Host on it. Run `pnpm --filter rstack test:e2e:fixtures` once beforehand to install the fixture dependencies.

## Submitting changes

- The pre-commit hook formats and lints staged files (`rs staged`).
- CI runs build, lint, format check, unit tests and the E2E suites on Linux and Windows — please run `pnpm lint && pnpm test:unit` locally before pushing.
- Keep PRs focused; fill in the PR template.
