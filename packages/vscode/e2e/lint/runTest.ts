/**
 * The `@vscode/test-electron` orchestrator for the ported Rslint E2E suites
 * (upstream `rslint/packages/vscode-extension/__tests__/runTest.ts`).
 *
 * Isolated-sandbox harness: suites intentionally create, rewrite and delete
 * config files, so every suite runs against a private temp copy of its fixture
 * workspace — even a crashing Extension Host cannot corrupt a tracked fixture.
 * A signed marker file lets the in-host runner (`runSuite.ts`) verify it is
 * inside a sandbox before a single test executes.
 *
 * Adaptations from upstream:
 * - The extension under test is `rstack.rstack` (the unified shell) built to
 *   `dist/extension.js`.
 * - There is no built-in binary: every fixture resolves
 *   `@rslint/core` — including its native Go binary — from the shared fixture
 *   install root (`e2e/lint/fixtures/package.json`, published npm
 *   versions). The sandbox preserves that resolution the way
 *   upstream preserved its monorepo package boundary: the install root's
 *   `package.json` is copied next to the workspace copy and its `node_modules`
 *   is symlinked there, so Node's walk-up resolution finds the real install
 *   without placing a writable `node_modules` inside the test workspace.
 * - Upstream's first suite ("JSON config tests") ran against the fixture
 *   shipped inside `@rslint/core` which was configured via `rslint.json`.
 *   `rslint.json` is not supported by this extension (JSON configs are
 *   deprecated upstream), so that
 *   fixture is ported as `fixtures/basic` with an equivalent
 *   `rslint.config.mjs`.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

interface TestSuite {
  name: string;
  workspace: string;
  tests: string;
  workspaceEntry?: string;
  workspaceFolders?: string[];
}

const workspaceMarkerFile = '.rstack-vscode-test-sandbox.json';

function resolveSandboxEntry(workspaceRoot: string, entry: string): string {
  const resolved = path.resolve(workspaceRoot, entry);
  const relative = path.relative(workspaceRoot, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Workspace entry escapes its isolated sandbox: ${entry}`);
  }
  return resolved;
}

async function findPackageRoot(startPath: string): Promise<string> {
  let current = path.resolve(startPath);
  for (;;) {
    try {
      await fs.promises.access(path.join(current, 'package.json'));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Could not find a package boundary above ${startPath}`);
      }
      current = parent;
    }
  }
}

async function runIsolatedSuite(
  extensionDevelopmentPath: string,
  vscodeExecutablePath: string,
  suite: TestSuite,
): Promise<void> {
  // Go discovery intentionally searches strict cwd ancestors, so keep each
  // fixture in a clean physical workspace outside this repository. Use short
  // paths on Unix as VS Code and the language client append socket names that
  // can otherwise exceed macOS's Unix-domain socket path limit.
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const profileRoot = await fs.promises.mkdtemp(path.join(tempRoot, 'rsv-'));
  const userDataDir = path.join(profileRoot, 'u');
  const extensionsDir = path.join(profileRoot, 'e');
  const workspaceCopy = path.join(profileRoot, 'w');

  let testError: unknown;
  try {
    // Suites intentionally create, rewrite, and delete config files. Run them
    // against a private copy so even an Extension Host crash cannot mutate a
    // tracked fixture in the checkout.
    await fs.promises.cp(suite.workspace, workspaceCopy, {
      recursive: true,
      force: false,
      errorOnExist: true,
      // Dependency lookup is reconstructed as one read-only parent symlink
      // below. Copying a fixture's disposable node_modules would be both slow
      // and a writable second resolution root inside the sandbox.
      filter: (source) => path.basename(source) !== 'node_modules',
    });
    const expectedWorkspaceFolders = await Promise.all(
      (suite.workspaceFolders ?? ['.']).map((folder) =>
        fs.promises.realpath(resolveSandboxEntry(workspaceCopy, folder)),
      ),
    );
    await fs.promises.writeFile(
      path.join(workspaceCopy, workspaceMarkerFile),
      JSON.stringify({
        version: 2,
        nonce: randomUUID(),
        sourceWorkspace: await fs.promises.realpath(suite.workspace),
        expectedWorkspace: await fs.promises.realpath(workspaceCopy),
        expectedWorkspaceFolders,
      }),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );

    // Preserve the fixture install root's package boundary and dependency
    // lookup (the project-resolved `@rslint/core`) without
    // placing a writable node_modules link inside the test workspace.
    const packageRoot = await findPackageRoot(suite.workspace);
    await fs.promises.copyFile(
      path.join(packageRoot, 'package.json'),
      path.join(profileRoot, 'package.json'),
    );
    await fs.promises.symlink(
      path.join(packageRoot, 'node_modules'),
      path.join(profileRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath: suite.tests,
      vscodeExecutablePath,
      launchArgs: [
        suite.workspaceEntry
          ? resolveSandboxEntry(workspaceCopy, suite.workspaceEntry)
          : workspaceCopy,
        // Keep VS Code's CI-only extension inventory and AgentHost info logs
        // out of test output while preserving an opt-in for diagnosis.
        `--log=${process.env.VSCODE_TEST_LOG_LEVEL ?? 'warn'}`,
        '--disable-extensions',
        '--disable-updates',
        // The fixtures spawn project-local binaries, which Restricted Mode
        // forbids by design.
        '--disable-workspace-trust',
        '--force-disable-user-env',
        '--skip-release-notes',
        '--skip-welcome',
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
      ],
    });
  } catch (error) {
    testError = error;
  }

  let cleanupError: unknown;
  try {
    await fs.promises.rm(profileRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  } catch (error) {
    cleanupError = error;
  }

  if (testError && cleanupError) {
    throw new AggregateError(
      [testError, cleanupError],
      `${suite.name} failed and its isolated sandbox could not be removed`,
    );
  }
  if (testError) throw testError;
  if (cleanupError) throw cleanupError;
}

async function main(): Promise<void> {
  // `__dirname` is `<package>/tests-dist/e2e/lint` (see tsconfig.e2e.json).
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const fixturesRoot = path.join(extensionDevelopmentPath, 'e2e/lint/fixtures');
  const sharedFixturesRoot = path.join(
    extensionDevelopmentPath,
    'e2e/fixtures',
  );
  const fixture = (name: string): string => path.join(fixturesRoot, name);
  const sharedFixture = (name: string): string =>
    path.join(sharedFixturesRoot, name);
  const suiteDir = (name: string): string => path.resolve(__dirname, name);

  // The extension host loads `main` from `package.json`; an unbuilt repo would
  // otherwise fail deep inside VS Code with an unhelpful activation error.
  if (
    !fs.existsSync(path.join(extensionDevelopmentPath, 'dist/extension.js'))
  ) {
    throw new Error(
      'dist/extension.js is missing — run `pnpm build` before `pnpm test:e2e:lint`.',
    );
  }
  // One shared install root serves every lint fixture workspace (published
  // @rslint/core) — that is what the guard probes.
  if (!fs.existsSync(path.join(fixturesRoot, 'node_modules'))) {
    throw new Error(
      'the lint E2E fixtures are not installed — run `pnpm test:e2e:fixtures lint`.',
    );
  }

  // Resolve the executable once so every suite explicitly uses the same one.
  // `VSCODE_TEST_EXECUTABLE`/`VSCODE_TEST_VERSION` mirror the other runners in
  // this repo; a cached download under `.vscode-test/` is reused.
  const vscodeExecutablePath =
    process.env.VSCODE_TEST_EXECUTABLE ||
    (await downloadAndUnzipVSCode({
      version: process.env.VSCODE_TEST_VERSION ?? 'stable',
      timeout: 60_000,
      extensionDevelopmentPath,
    }));

  const suites: TestSuite[] = [
    {
      // Upstream "JSON config tests": same suite, JS-config fixture (JSON
      // configs are deprecated upstream and unsupported here).
      name: 'Basic config tests',
      workspace: fixture('basic'),
      tests: suiteDir('suite'),
    },
    {
      name: 'JS config tests',
      workspace: fixture('jsconfig'),
      tests: suiteDir('suite-jsconfig'),
    },
    {
      name: 'Monorepo config tests',
      workspace: fixture('monorepo'),
      tests: suiteDir('suite-monorepo'),
    },
    {
      name: 'Multi-root dynamic ownership tests',
      workspace: fixture('multiroot'),
      tests: suiteDir('suite-multiroot'),
      workspaceEntry: 'multiroot.code-workspace',
      workspaceFolders: [
        'parent',
        'sentinel',
        'twins/left/app',
        'twins/right/app',
      ],
    },
    {
      name: 'Multi-root initial parent-child tests',
      workspace: fixture('multiroot'),
      tests: suiteDir('suite-multiroot'),
      workspaceEntry: 'nested-initial.code-workspace',
      workspaceFolders: ['parent', 'parent/nested', 'sentinel'],
    },
    {
      name: 'No config tests',
      workspace: fixture('noconfig'),
      tests: suiteDir('suite-noconfig'),
    },
    {
      name: 'Type-aware scope tests',
      workspace: fixture('type-aware-scope'),
      tests: suiteDir('suite-type-aware-scope'),
    },
    {
      name: 'projectService scope tests',
      workspace: fixture('project-service-scope'),
      tests: suiteDir('suite-project-service-scope'),
    },
    {
      name: 'eslintPlugins tests',
      workspace: fixture('eslint-plugins'),
      tests: suiteDir('suite-eslint-plugins'),
    },
    {
      name: 'Generated rule-option-types tests',
      workspace: fixture('rule-option-types'),
      tests: suiteDir('suite-rule-option-types'),
    },
    {
      name: 'Self-documenting diagnostics tests',
      workspace: fixture('hover'),
      tests: suiteDir('suite-hover'),
    },
    {
      name: 'import/no-cycle tests',
      workspace: fixture('import-cycle'),
      tests: suiteDir('suite-import-cycle'),
    },
    {
      name: 'Rstack lint bridge tests',
      workspace: sharedFixture('rstack'),
      tests: suiteDir('suite-bridge'),
    },
  ];

  // Optional development filter: `RSTACK_LINT_E2E_SUITES="No config,Monorepo"`
  // runs only the suites whose name contains one of the comma-separated
  // fragments (case-insensitive). CI leaves it unset and runs everything.
  const suiteFilter = (process.env.RSTACK_LINT_E2E_SUITES ?? '')
    .split(',')
    .map((fragment) => fragment.trim().toLowerCase())
    .filter((fragment) => fragment.length > 0);
  const selectedSuites =
    suiteFilter.length === 0
      ? suites
      : suites.filter((suite) =>
          suiteFilter.some((fragment) =>
            suite.name.toLowerCase().includes(fragment),
          ),
        );
  if (selectedSuites.length === 0) {
    throw new Error(
      `RSTACK_LINT_E2E_SUITES matched no suites: ${process.env.RSTACK_LINT_E2E_SUITES}`,
    );
  }

  const failures: unknown[] = [];
  for (const suite of selectedSuites) {
    console.log(`\n=== ${suite.name} ===`);
    try {
      await runIsolatedSuite(
        extensionDevelopmentPath,
        vscodeExecutablePath,
        suite,
      );
    } catch (error) {
      console.error(`${suite.name} failed:`, error);
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} VS Code suite(s) failed`,
    );
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
