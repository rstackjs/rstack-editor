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
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

const FIXTURE_DIRS = ['workspace-1', 'workspace-2'] as const;

async function main() {
  // `__dirname` is `<repo>/tests-dist/e2e/rstest` (see tsconfig.e2e.json).
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const fixturesRoot = path.join(
    extensionDevelopmentPath,
    'e2e/rstest/fixtures',
  );

  // The extension host loads `main` from `package.json`; an unbuilt repo would
  // otherwise fail deep inside VS Code with an unhelpful activation error.
  if (!existsSync(path.join(extensionDevelopmentPath, 'dist/extension.js'))) {
    throw new Error(
      'dist/extension.js is missing — run `pnpm build` before `pnpm test:e2e:rstest`.',
    );
  }
  // workspace-2 has no node_modules of its own per project; the root install
  // serves both nested projects, so the root is what the guard probes.
  for (const name of FIXTURE_DIRS) {
    if (!existsSync(path.join(fixturesRoot, name, 'node_modules'))) {
      throw new Error(
        `the rstest/${name} E2E fixture is not installed — run \`pnpm test:e2e:fixtures\`.`,
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

  await runTests({
    // Pinnable for CI; `stable` locally. `runTests` forwards the whole options
    // object to the downloader, so `version`/`timeout`/`vscodeExecutablePath`
    // all apply to it. A cached download under `.vscode-test/` is reused.
    version: process.env.VSCODE_TEST_VERSION ?? 'stable',
    timeout: 60_000,
    // Escape hatch for offline / restricted environments: point at an existing
    // VS Code and nothing is downloaded at all.
    vscodeExecutablePath: process.env.VSCODE_TEST_EXECUTABLE || undefined,
    extensionDevelopmentPath,
    extensionTestsPath,
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
  });
}

main().catch((error) => {
  console.error('Failed to run Rstest E2E tests');
  console.error(error);
  process.exit(1);
});
