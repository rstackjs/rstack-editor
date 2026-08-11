// The single E2E entry point: `node ./e2e/run.mjs [slice ...]` (via
// `pnpm test:e2e [slice ...]`). No arguments runs every slice in table order.
//
// SLICES is the single source of truth for what E2E slices exist: which
// fixtures each needs installed and which script runs it. The package.json
// `test:e2e*` scripts are thin forwards to this file and carry none of that
// knowledge. The shared `tsc -p tsconfig.e2e.json` pass runs first (the
// cheap, likely-to-fail step), then the selected slices' fixtures install in
// one `setupFixtures.mjs` invocation (idempotent — pnpm no-ops on an
// up-to-date fixture, and unknown names throw there), then the entries run
// sequentially — each `compile`d entry launches its own VS Code via
// `@vscode/test-electron`.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {{name: string, fixtures: string[], entry: string, compile?: boolean}[]} */
const SLICES = [
  {
    // A plain Node script — no VS Code, no TypeScript compile.
    name: 'smoke',
    fixtures: ['rslint'],
    entry: 'e2e/smoke/rslintPluginHost.mjs',
  },
  {
    // The shell/detection/fmt suites (`e2e/suite/`) over the multi-root
    // workspace of the three shared fixtures.
    name: 'vscode',
    fixtures: ['rslint', 'rstest', 'rstack'],
    entry: 'tests-dist/e2e/runTest.js',
    compile: true,
  },
  {
    // The ported Rstest suites, plus `suite/bridge.test.ts`, which adds the
    // shared `rstack` fixture as a second workspace folder.
    name: 'rstest',
    fixtures: ['rstest-workspace-1', 'rstest-workspace-2', 'rstack'],
    entry: 'tests-dist/e2e/rstest/runTest.js',
    compile: true,
  },
  {
    // The ported Rslint suites, plus `suite-rstack-bridge/`, which runs
    // against the shared `rstack` fixture (its own install root — the only
    // lint workspace whose `node_modules` lives inside the workspace itself).
    // `RSTACK_LINT_E2E_SUITES=<name,...>` filters which of them run.
    name: 'lint',
    fixtures: ['lint', 'rstack'],
    entry: 'tests-dist/e2e/lint/runTest.js',
    compile: true,
  },
];

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{shell?: boolean}} [opts]
 */
const run = (command, args, opts = {}) => {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    stdio: 'inherit',
    env: process.env,
    // With `shell: true` Node concatenates command and args UNESCAPED, so a
    // path containing spaces (the checkout, `process.execPath`) would fall
    // apart into several arguments — callers opt in only where the command
    // cannot spawn without a shell and every argument is a fixed safe token.
    shell: opts.shell ?? false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const known = SLICES.map((slice) => slice.name);
const requested = process.argv.slice(2);
for (const name of requested) {
  if (!known.includes(name)) {
    throw new Error(`unknown E2E slice: ${name} (known: ${known.join(', ')})`);
  }
}
const selected =
  requested.length > 0
    ? SLICES.filter((slice) => requested.includes(slice.name))
    : SLICES;

if (selected.some((slice) => slice.compile)) {
  console.log('[e2e] compiling slices (tsc -p tsconfig.e2e.json)');
  // On Windows, pnpm is a .cmd shim, and Node refuses to spawn batch files
  // without a shell (CVE-2024-27980 hardening) — EINVAL otherwise. The shell
  // stays confined to this spawn: its arguments are fixed safe tokens.
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.e2e.json'], {
    shell: process.platform === 'win32',
  });
}

run(process.execPath, [
  'e2e/setupFixtures.mjs',
  ...new Set(selected.flatMap((slice) => slice.fixtures)),
]);

for (const slice of selected) {
  console.log(`[e2e] running slice: ${slice.name}`);
  run(process.execPath, [path.join(packageRoot, slice.entry)]);
}
