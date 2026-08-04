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

const FIXTURE_NAMES = ['rslint', 'rstest', 'rstack'] as const;

async function main() {
  // `__dirname` is `<repo>/tests-dist/tests/e2e` (see tsconfig.e2e.json).
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const fixturesDir = path.join(extensionDevelopmentPath, 'tests/e2e/fixtures');
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

  // A short user-data dir keeps the Unix socket paths below the macOS limit.
  const hash = createHash('sha1')
    .update(extensionDevelopmentPath)
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
      workspaceFile,
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

main().catch((error) => {
  console.error('Failed to run E2E tests');
  console.error(error);
  process.exit(1);
});
