/**
 * The `@vscode/test-electron` entry point.
 *
 * It downloads (and caches) a real VS Code, launches it with this repo as the
 * extension under development, opens the multi-root fixture workspace and hands
 * control to `suite/index.ts` inside the extension host.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

const FIXTURE_NAMES = [
  'rslint',
  'rstest',
  'rstack',
  'fmt-missing-config-dependency',
] as const;

interface LaunchOptions {
  readonly extensionDevelopmentPath: string;
  readonly extensionTestsPath: string;
  readonly workspace: string;
  readonly profileSuffix: string;
}

async function launch({
  extensionDevelopmentPath,
  extensionTestsPath,
  workspace,
  profileSuffix,
}: LaunchOptions): Promise<void> {
  // A short user-data dir keeps the Unix socket paths below the macOS limit.
  const hash = createHash('sha1')
    .update(`${extensionDevelopmentPath}\0${profileSuffix}`)
    .digest('hex')
    .slice(0, 8);
  const userDataDir = mkdtempSync(path.join(tmpdir(), `rstack-${hash}-`));

  await runTests({
    // Pinnable for CI; `stable` locally. `runTests` forwards the whole options
    // object to the downloader, so `version`/`timeout`/`vscodeExecutablePath`
    // all apply to it.
    version: process.env.VSCODE_TEST_VERSION ?? 'stable',
    // The default per-request timeout is 15s, which a 300 MB download on a slow
    // or proxied link loses to before it ever starts making progress.
    timeout: 60_000,
    // Escape hatch for offline / restricted environments: point at an existing
    // VS Code (`.../Visual Studio Code.app/Contents/MacOS/Electron`, `Code.exe`,
    // `code`) and nothing is downloaded at all.
    vscodeExecutablePath: process.env.VSCODE_TEST_EXECUTABLE || undefined,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspace,
      // Keep VS Code's CI-only extension inventory and AgentHost info logs out
      // of test output while preserving an opt-in for verbose diagnosis.
      `--log=${process.env.VSCODE_TEST_LOG_LEVEL ?? 'warn'}`,
      // Only the extension under development runs: no user extension may
      // register a competing formatter, test controller or language client.
      '--disable-extensions',
      // The fixtures spawn project-local binaries, which Restricted Mode
      // forbids by design. Trust is granted up front so the
      // suite tests the trusted path; the Restricted Mode path needs its own
      // launch and is not covered in phase 1.
      '--disable-workspace-trust',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--user-data-dir',
      userDataDir,
    ],
  });
}

async function main() {
  // `__dirname` is `<repo>/tests-dist/e2e` (see tsconfig.e2e.json).
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const fixturesDir = path.join(extensionDevelopmentPath, 'e2e/fixtures');
  const workspaceFile = path.join(fixturesDir, 'e2e.code-workspace');

  // The extension host loads `main` from `package.json`; an unbuilt repo would
  // otherwise fail deep inside VS Code with an unhelpful activation error.
  if (!existsSync(path.join(extensionDevelopmentPath, 'dist/extension.js'))) {
    throw new Error(
      'dist/extension.js is missing — run `pnpm build` before `pnpm test:e2e`.',
    );
  }
  for (const name of FIXTURE_NAMES) {
    if (!existsSync(path.join(fixturesDir, name, 'node_modules'))) {
      throw new Error(
        `the ${name} E2E fixture is not installed — run \`pnpm test:e2e:fixtures\`.`,
      );
    }
  }

  await launch({
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(__dirname, './suite/index'),
    workspace: workspaceFile,
    profileSuffix: 'main',
  });
  await launch({
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(
      __dirname,
      './suite-fmt-missing-config-dependency/index',
    ),
    workspace: path.join(fixturesDir, 'fmt-missing-config-dependency'),
    profileSuffix: 'fmt-missing-config-dependency',
  });
  await launchRstackCliPackagePath(extensionDevelopmentPath, fixturesDir);
}

/**
 * The #103 layout must run outside this repository: a walk-up from a fixture
 * inside the checkout would reach the repository's own `node_modules/rstack`,
 * which would satisfy all three stacks without the setting under test. The
 * copy keeps the layout and links `infra/node_modules` back to the installed
 * fixture, so `rstack` stays reachable only through
 * `rstack.rstackCli.packagePath`.
 */
async function launchRstackCliPackagePath(
  extensionDevelopmentPath: string,
  fixturesDir: string,
): Promise<void> {
  const fixture = path.join(fixturesDir, 'rstack-cli-package-path');
  const installed = path.join(fixture, 'infra', 'node_modules');
  if (!existsSync(installed)) {
    throw new Error(
      'the rstack-cli-package-path E2E fixture is not installed — run `pnpm test:e2e:fixtures`.',
    );
  }
  // Short on Unix: VS Code appends socket names to paths under the workspace.
  const sandbox = mkdtempSync(
    path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'rsp-'),
  );
  const workspace = path.join(sandbox, 'w');
  try {
    cpSync(fixture, workspace, {
      recursive: true,
      filter: (source) => path.basename(source) !== 'node_modules',
    });
    symlinkSync(
      installed,
      path.join(workspace, 'infra', 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await launch({
      extensionDevelopmentPath,
      extensionTestsPath: path.resolve(
        __dirname,
        './suite-rstack-cli-package-path/index',
      ),
      workspace,
      profileSuffix: 'rstack-cli-package-path',
    });
  } finally {
    rmSync(sandbox, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
}

main().catch((error) => {
  console.error('Failed to run E2E tests');
  console.error(error);
  process.exit(1);
});
