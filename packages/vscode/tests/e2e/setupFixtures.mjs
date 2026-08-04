// Installs the E2E fixture workspaces.
//
// The fixtures install **published npm versions** of
// `@rslint/core` / `@rstest/core` / `rstack` — the extension resolves all three
// from the project, so a fixture that linked this repo's own node_modules would
// test nothing. Each fixture is its own independent install; `--ignore-workspace`
// makes sure pnpm never folds them into a parent workspace.
//
// Idempotent: pnpm is a no-op when the fixture is already up to date, so
// `test:e2e` can always run it.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(here, 'fixtures');
/**
 * Fixture name -> project directory. The `rstest-workspace-*` entries are the
 * projects the ported Rstest suites (`tests/e2e/rstest/`) run against;
 * workspace-2 is one install at its root serving both nested projects. The
 * `lint` entry is the shared install root serving every ported Rslint suite
 * workspace (`tests/e2e/lint/fixtures/*` — the workspaces themselves have no
 * package.json; @rslint/core resolves via Node's walk-up from one install).
 */
export const FIXTURES = {
  rslint: path.join(FIXTURES_DIR, 'rslint'),
  rstest: path.join(FIXTURES_DIR, 'rstest'),
  rstack: path.join(FIXTURES_DIR, 'rstack'),
  'rstest-workspace-1': path.join(here, 'rstest', 'fixtures', 'workspace-1'),
  'rstest-workspace-2': path.join(here, 'rstest', 'fixtures', 'workspace-2'),
  lint: path.join(here, 'lint', 'fixtures'),
};
export const FIXTURE_NAMES = Object.keys(FIXTURES);

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/** @param {string} name */
const install = (name) => {
  const cwd = FIXTURES[name];
  if (!existsSync(path.join(cwd, 'package.json'))) {
    throw new Error(`E2E fixture ${name} has no package.json at ${cwd}`);
  }
  console.log(`[e2e] installing fixture: ${name}`);
  const result = spawnSync(
    pnpmCommand,
    [
      'install',
      // A fixture is a standalone project, never a workspace member of this
      // repo: the whole point is a plain, published-versions install.
      '--ignore-workspace',
      // Fixtures pin ranges, not a lockfile — a frozen lockfile would fail CI
      // the moment a patch release lands.
      '--no-frozen-lockfile',
      '--prefer-offline',
      // Changing a fixture's `.npmrc` makes pnpm want to purge `node_modules`,
      // which it refuses to do without a TTY. The directory is disposable.
      '--config.confirmModulesPurge=false',
      // Fixtures deliberately install pinned published versions of the Rstack
      // toolchain, which are often hours old — disable pnpm's
      // minimum-release-age supply-chain gate for these sandboxes. It must be
      // a CLI flag: `--ignore-workspace` also ignores a local
      // pnpm-workspace.yaml, and pnpm would otherwise auto-write exclusion
      // files into the fixture.
      '--config.minimumReleaseAge=0',
      // pnpm's build-script gate exits non-zero on unapproved postinstalls
      // (e.g. core-js in the rstest fixture). These sandboxes install real
      // published packages exactly like a user project would, so run their
      // build scripts as-is.
      '--config.dangerouslyAllowAllBuilds=true',
    ],
    { cwd, stdio: 'inherit', env: process.env },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `pnpm install failed for the ${name} fixture (exit code ${String(result.status)})`,
    );
  }
};

const main = () => {
  const requested = process.argv.slice(2);
  const names = requested.length > 0 ? requested : FIXTURE_NAMES;
  for (const name of names) {
    if (!FIXTURE_NAMES.includes(name)) {
      throw new Error(
        `unknown E2E fixture: ${name} (known: ${FIXTURE_NAMES.join(', ')})`,
      );
    }
    install(name);
  }
};

main();
