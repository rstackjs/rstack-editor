/**
 * The `@vscode/test-electron` entry point for the ported Rstest suites
 * (upstream `rstest/packages/vscode/tests/runTest.ts`, restated on this repo's
 * harness patterns — see `e2e/runTest.ts`).
 *
 * Unlike the shell/detection harness this one does **not** open a checked-in
 * workspace file: `suite/workspace.test.ts` calls `updateWorkspaceFolders` to
 * add and remove `workspace-2`, and VS Code persists folder changes back into
 * the file it opened. The workspace file is therefore generated per run in the
 * scratch dir, so every run starts from the identical single-folder state and
 * a failure between the add and the remove never reaches the repository.
 *
 * Each fixture carries a `.nvmrc`: the extension's shell probe stands in the
 * opened fixture folder and deliberately never walks upward (ADR 0001), so
 * without a local pin a developer machine's version-manager *default* — not
 * anything this repo controls — would decide whether the Node preflight
 * clears the floor. Inert in CI, which puts a new-enough `node` on PATH so
 * the shell probe never runs.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

// TEMPORARY (debug/linux-watcher): how many inotify instances the system is
// currently holding — the ceiling that panel runs hit (max_user_instances).
const countInotifyFds = (): number => {
  let count = 0;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      for (const fd of readdirSync(`/proc/${entry}/fd`)) {
        const target = readlinkSync(`/proc/${entry}/fd/${fd}`);
        if (
          target === 'anon_inode:inotify' ||
          target === 'anon_inode:[inotify]'
        ) {
          count += 1;
        }
      }
    } catch {
      // A process may exit between listing and reading; ignore.
    }
  }
  return count;
};
import { vscodeTestCachePath } from '../vscodeTestCache';

// Repo-relative fixture dirs whose installs this slice needs. workspace-2 has
// no node_modules of its own per project; the root install serves both nested
// projects, so the root is what the guard probes. `e2e/fixtures/rstack` is the
// shared fixture `suite/bridge.test.ts` adds as a second workspace folder (the
// same folder the `vscode` slice opens); the bridge resolves the rstack shim
// from its install.
const FIXTURE_DIRS = [
  'e2e/rstest/fixtures/workspace-1',
  'e2e/rstest/fixtures/workspace-2',
  'e2e/fixtures/rstack',
] as const;

async function main() {
  // `__dirname` is `<repo>/tests-dist/e2e/rstest` (see tsconfig.e2e.json).
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const fixturesRoot = path.join(
    extensionDevelopmentPath,
    'e2e/rstest/fixtures',
  );

  // TEMPORARY environment diagnostics for the debug/linux-watcher branch.
  // One-off lines in the job output so a runner-side copy of the failing
  // ecosystem-ci context can be compared against local/leg tracks.
  if (process.env.CI === 'true' || process.env.RSTACK_DETECTION_DIAG === '1') {
    const procRoot = '/proc/sys/fs/inotify';
    try {
      console.error(`[e2e-env] time ${new Date().toISOString()}`);
      console.error(
        `[e2e-env] node ${process.version} ${process.platform} ${process.arch}`,
      );
      console.error(
        `[e2e-env] fixtures ${fixturesRoot}`,
        `root-dev=${statSync(fixturesRoot).dev}`,
      );
      for (const limit of [
        'max_user_watches',
        'max_user_instances',
        'max_queued_events',
      ]) {
        console.error(
          `[e2e-env] inotify ${limit} ${readFileSync(`${procRoot}/${limit}`, 'utf8').trim()}`,
        );
      }
      console.error(`[e2e-env] inotify instances in use: ${countInotifyFds()}`);
      console.error(
        `[e2e-env] df -T fixtures:\n${execFileSync('df', ['-T', fixturesRoot], { encoding: 'utf8' })}`,
      );
      console.error(
        `[e2e-env] toolchain override ${process.env.RSTACK_E2E_TOOLCHAIN_OVERRIDES || '(unset)'}`,
      );
    } catch (error) {
      console.error(`[e2e-env] diagnostics failed: ${error}`);
    }
  }

  // The extension host loads `main` from `package.json`; an unbuilt repo would
  // otherwise fail deep inside VS Code with an unhelpful activation error.
  if (!existsSync(path.join(extensionDevelopmentPath, 'dist/extension.js'))) {
    throw new Error(
      'dist/extension.js is missing — run `pnpm build` before `pnpm test:e2e:rstest`.',
    );
  }
  for (const dir of FIXTURE_DIRS) {
    if (!existsSync(path.join(extensionDevelopmentPath, dir, 'node_modules'))) {
      throw new Error(
        `the ${dir} E2E fixture is not installed — run \`pnpm test:e2e:fixtures\`.`,
      );
    }
  }

  // A short user-data dir keeps the Unix socket paths below the macOS limit.
  const hash = createHash('sha1')
    .update(`${extensionDevelopmentPath}:rstest`)
    .digest('hex')
    .slice(0, 8);
  const scratchDir = mkdtempSync(path.join(tmpdir(), `rstack-${hash}-`));

  // Only workspace-1 to start with; workspace.test.ts adds workspace-2 itself.
  const workspaceFile = path.join(scratchDir, 'rstest-e2e.code-workspace');
  writeFileSync(
    workspaceFile,
    `${JSON.stringify(
      {
        folders: [{ path: path.join(fixturesRoot, 'workspace-1') }],
        settings: { 'files.exclude': { '**/node_modules': true } },
      },
      null,
      2,
    )}\n`,
  );

  const launchOptions = {
    // Pinnable for CI; `stable` locally. `runTests` forwards the whole options
    // object to the downloader, so `version`/`timeout`/`vscodeExecutablePath`
    // all apply to it. A cached download under `.vscode-test/` is reused.
    version: process.env.VSCODE_TEST_VERSION ?? 'stable',
    timeout: 60_000,
    // Escape hatch for offline / restricted environments: point at an existing
    // VS Code and nothing is downloaded at all.
    vscodeExecutablePath: process.env.VSCODE_TEST_EXECUTABLE || undefined,
    cachePath: vscodeTestCachePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    // In CI the rstest output channel is unreadable, so the extension mirrors
    // it to the console (see `src/stacks/test/logger.ts`) — the only way to
    // see why a worker failed on a platform we cannot reproduce locally.
    extensionTestsEnv: process.env.CI
      ? { RSTACK_E2E_MIRROR_LOGS: '1' }
      : undefined,
    launchArgs: [
      workspaceFile,
      // Keep VS Code's CI-only extension inventory and AgentHost info logs out
      // of test output while preserving an opt-in for verbose diagnosis.
      `--log=${process.env.VSCODE_TEST_LOG_LEVEL ?? 'warn'}`,
      // Only the extension under development runs: no user extension may
      // register a competing test controller.
      '--disable-extensions',
      // The fixtures spawn project-local workers, which Restricted Mode
      // forbids by design.
      '--disable-workspace-trust',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--user-data-dir',
      scratchDir,
    ],
  };
  await runTests(launchOptions);

  // Reuse setupFixtures.mjs's exact published pin and generated lockfile,
  // but start this isolated workspace with no inherited node_modules.
  const recoveryRoot = mkdtempSync(path.join(tmpdir(), 'rst-recovery-'));
  const recoveryWorkspace = path.join(recoveryRoot, 'workspace');
  try {
    cpSync(path.join(fixturesRoot, 'workspace-1'), recoveryWorkspace, {
      recursive: true,
      filter: (source) => path.basename(source) !== 'node_modules',
    });
    await runTests({
      ...launchOptions,
      extensionTestsPath: path.resolve(
        __dirname,
        './suite-dependency-recovery/index',
      ),
      launchArgs: [
        recoveryWorkspace,
        ...launchOptions.launchArgs.slice(1, -2),
        '--user-data-dir',
        path.join(recoveryRoot, 'profile'),
      ],
    });
  } finally {
    rmSync(recoveryRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
}

main().catch((error) => {
  console.error('Failed to run Rstest E2E tests');
  console.error(error);
  process.exit(1);
});
