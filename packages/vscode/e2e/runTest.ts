/**
 * The `@vscode/test-electron` entry point.
 *
 * It downloads (and caches) a real VS Code, launches it with this repo as the
 * extension under development, opens the multi-root fixture workspace and hands
 * control to `suite/index.ts` inside the extension host.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
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
  const hash = createHash('sha1')
    .update(`${extensionDevelopmentPath}\0${profileSuffix}`)
    .digest('hex')
    .slice(0, 8);
  const userDataDir = mkdtempSync(path.join(tmpdir(), `rstack-${hash}-`));

  await runTests({
    version: process.env.VSCODE_TEST_VERSION ?? 'stable',
    timeout: 60_000,
    vscodeExecutablePath: process.env.VSCODE_TEST_EXECUTABLE || undefined,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspace,
      `--log=${process.env.VSCODE_TEST_LOG_LEVEL ?? 'warn'}`,
      '--disable-extensions',
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
}

main().catch((error) => {
  console.error('Failed to run E2E tests');
  console.error(error);
  process.exit(1);
});
