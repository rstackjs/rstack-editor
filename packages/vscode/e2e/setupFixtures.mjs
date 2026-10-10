// Installs the E2E fixture workspaces.
//
// The fixtures install **exact published npm versions** of
// `@rslint/core` / `@rstest/core` / `rstack` — the extension resolves all three
// from the project, so a fixture that linked this repo's own node_modules would
// test nothing. `rstack@0.8.2` itself pins `@rslint/core@0.9.5` exactly, so the
// Rstack fixture pins its lint core transitively. Each fixture is its own
// independent install. Exact toolchain pins make installs reproducible
// without committed lockfiles, and Renovate bumps those pins.
//
// Each fixture carries a committed, settings-only `pnpm-workspace.yaml`. It
// stops pnpm from walking up into this repo's workspace, and it exempts the
// Rstack family from pnpm's `minimumReleaseAge` gate (fixtures pin releases
// that are often hours old; third-party packages stay gated). The exemption
// has to live in a file rather than `--config.minimumReleaseAge=0` because the
// dependency-recovery tests copy a fixture to the OS tmpdir and re-install
// with `--frozen-lockfile`, and pnpm 11 re-checks release age even when
// frozen, so the policy must travel with the copy. The same file rules out
// `--ignore-workspace`, under which pnpm ignores its settings. Setup-only
// options stay flags below. Keep the list in step with the root
// `pnpm-workspace.yaml`.
//
// Idempotent: pnpm is a no-op when the fixture is already up to date, so
// `test:e2e` can always run it.
//
// `RSTACK_E2E_TOOLCHAIN_OVERRIDES="@rstest/core=/abs/rstest/packages/core,…"`
// installs unreleased builds instead, for rstack-ecosystem-ci (#40). Its root
// `pnpm-workspace.yaml` override cannot reach the fixtures, which are their own
// workspace roots, so each package is packed into `<fixture>/.toolchain/` and
// the fixture yaml gets a relative `file:` override: the dependency-recovery
// suites copy a fixture to tmpdir and reinstall with `--frozen-lockfile`, and
// pnpm records `file:` relative to the lockfile. After install the lockfile
// must resolve each overridden package through the tarball, never the
// registry: build and pin can share a version number, which proves nothing.
// The yaml is changed in place and never restored: the env is meant for
// disposable checkouts (ecosystem CI); locally,
// `git checkout -- packages/vscode/e2e` undoes it.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(here, 'fixtures');
/**
 * Fixture name -> project directory. The `rstest-workspace-*` entries are the
 * projects the ported Rstest suites (`e2e/rstest/`) run against;
 * workspace-2 is one install at its root serving both nested projects. The
 * `lint` entry is the shared install root serving every ported Rslint suite
 * workspace (`e2e/lint/fixtures/*` — the workspaces themselves have no
 * package.json; @rslint/core resolves via Node's walk-up from one install).
 * A fixture that a test-worker-spawning slice opens as a workspace folder
 * carries a `.nvmrc` pin — rationale in the `e2e/rstest/runTest.ts` header.
 */
export const FIXTURES = {
  rslint: path.join(FIXTURES_DIR, 'rslint'),
  rstest: path.join(FIXTURES_DIR, 'rstest'),
  rstack: path.join(FIXTURES_DIR, 'rstack'),
  'rstack-fmt-only': path.join(FIXTURES_DIR, 'rstack-fmt-only'),
  'rstest-ownership': path.join(FIXTURES_DIR, 'rstest-ownership'),
  'fmt-missing-config-dependency': path.join(
    FIXTURES_DIR,
    'fmt-missing-config-dependency',
  ),
  'rstest-workspace-1': path.join(here, 'rstest', 'fixtures', 'workspace-1'),
  'rstest-workspace-2': path.join(here, 'rstest', 'fixtures', 'workspace-2'),
  lint: path.join(here, 'lint', 'fixtures'),
  'lint-dependency-recovery': path.join(
    here,
    'lint',
    'fixtures',
    'dependency-recovery',
  ),
  'lint-document-ownership': path.join(
    here,
    'lint',
    'fixtures',
    'document-ownership',
  ),
};
export const FIXTURE_NAMES = Object.keys(FIXTURES);

const pnpmCommand = 'pnpm';

/** `name=<absolute package dir>` entries, comma-separated; unset → none. */
const overrides = (process.env.RSTACK_E2E_TOOLCHAIN_OVERRIDES ?? '')
  .split(',')
  .filter((entry) => entry.trim())
  .map((entry) => {
    const [pkg = '', dir = ''] = entry
      .split(/=(.*)/)
      .map((part) => part.trim());
    // Without this, a missing `=` packs `packages/vscode` itself.
    if (
      !pkg ||
      !path.isAbsolute(dir) ||
      !existsSync(path.join(dir, 'package.json'))
    ) {
      throw new Error(
        `RSTACK_E2E_TOOLCHAIN_OVERRIDES: expected name=<absolute package dir>, got ${entry}`,
      );
    }
    return { pkg, dir, file: `${pkg.replace(/^@/, '').replace('/', '-')}.tgz` };
  });

/**
 * @param {string[]} args
 * @param {string} cwd
 */
const pnpm = (args, cwd) => {
  const result = spawnSync(pnpmCommand, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
    // On Windows, pnpm is a .cmd shim, and Node refuses to spawn batch
    // files without a shell (CVE-2024-27980 hardening) — EINVAL otherwise.
    shell: process.platform === 'win32',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${args[0]} failed in ${cwd} (exit code ${String(result.status)})`,
    );
  }
};

/** @param {string} cwd */
const injectOverrides = (cwd) => {
  const yamlPath = path.join(cwd, 'pnpm-workspace.yaml');
  // A second run in the same checkout must not append a duplicate key.
  if (readFileSync(yamlPath, 'utf8').includes('.toolchain/')) {
    return;
  }
  mkdirSync(path.join(cwd, '.toolchain'), { recursive: true });
  const lines = ['# RSTACK_E2E_TOOLCHAIN_OVERRIDES: .toolchain/', 'overrides:'];
  for (const { pkg, dir, file } of overrides) {
    pnpm(['pack', '--out', path.join(cwd, '.toolchain', file)], dir);
    lines.push(`  '${pkg}': 'file:.toolchain/${file}'`);
  }
  lines.push('');
  appendFileSync(yamlPath, `\n${lines.join('\n')}`);
};

// Fixtures that do not depend on an overridden package are legitimate no-ops;
// only a run where no fixture used any override is an error.
let resolvedThroughTarball = 0;

/** @param {string} name */
const install = (name) => {
  const cwd = FIXTURES[name];
  if (!existsSync(path.join(cwd, 'package.json'))) {
    throw new Error(`E2E fixture ${name} has no package.json at ${cwd}`);
  }
  if (overrides.length > 0) {
    injectOverrides(cwd);
  }
  console.log(`[e2e] installing fixture: ${name}`);
  // Keep pnpm's default isolated layout. In the rstack fixture the tool cores
  // are transitive dependencies beside rstack in the virtual store, matching
  // the layout users get rather than masking resolution bugs with public
  // hoisting.
  pnpm(
    [
      'install',
      // Fixtures pin exact toolchain versions rather than committing lockfiles;
      // Renovate updates the pins.
      '--no-frozen-lockfile',
      '--prefer-offline',
      // Changing a fixture's install config makes pnpm want to purge
      // `node_modules`, which it refuses to do without a TTY. The directory is
      // disposable.
      '--config.confirmModulesPurge=false',
      // pnpm's build-script gate exits non-zero on unapproved postinstalls
      // (e.g. core-js in the rstest fixture). These sandboxes install real
      // published packages exactly like a user project would, so run their
      // build scripts as-is.
      '--config.dangerouslyAllowAllBuilds=true',
    ],
    cwd,
  );
  // A registry resolution is `name@1.2.3`, the tarball `name@file:…`; the
  // lockfile also covers transitive ones (the rstack fixture's @rstest/core).
  const lockfile =
    overrides.length > 0
      ? readFileSync(path.join(cwd, 'pnpm-lock.yaml'), 'utf8')
      : '';
  for (const { pkg } of overrides) {
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    // The lookbehind keeps `rstack` from matching `create-rstack@1.0.0`.
    if (new RegExp(`(?<![\\w@/.-])${escaped}@\\d`).test(lockfile)) {
      throw new Error(
        `\`${pkg}\` still resolves to a registry version in the ${name} fixture`,
      );
    }
    if (!lockfile.includes(`${pkg}@file:`)) {
      console.log(`[e2e] ${name}: ${pkg} not in graph, override unused`);
      continue;
    }
    resolvedThroughTarball += 1;
    console.log(
      `[e2e] ${name}: ${pkg} resolved through .toolchain (no registry version in pnpm-lock.yaml)`,
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
  if (overrides.length > 0 && resolvedThroughTarball === 0) {
    throw new Error(
      `RSTACK_E2E_TOOLCHAIN_OVERRIDES: no fixture in this run resolved ${overrides.map(({ pkg }) => pkg).join(', ')} through a tarball; the override did nothing`,
    );
  }
};

main();
