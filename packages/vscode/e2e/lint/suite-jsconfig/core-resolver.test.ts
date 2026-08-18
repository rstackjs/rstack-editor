// Ported from web-infra-dev/rslint
// `packages/vscode-extension/__tests__/suite-jsconfig/core-resolver.test.ts`
// (rslint #1617, commit 39536fd6).
//
// Adaptations from upstream (see packages/vscode/AGENTS.md, adaptation 7):
// - Upstream's resolver *loads* the selected `@rslint/core` in the extension
//   host (`config-loader`, `eslint-plugin`, `resolveRslintBinary()`). Here the
//   host must never load project code (ADR 0003): it walks the package chain
//   with plain `fs` calls and version-gates the manifest, and the Lint worker
//   takes the last hop. So a fixture core is just a `package.json` — there is
//   no `createLoadableCore`, no binary, and no `installation.binaryPath`.
// - `resolveCorePackageDirectory(dir, corePath?)` has no exported twin here;
//   the equivalent host-side walk is `resolveRslint()` from `resolution.ts`,
//   wrapped below as `resolveCoreDirectory`.
// - `CoreNotFoundError` was not ported: our chain reports every failure as
//   `RslintResolutionError` with a code (`missing-core` here), which is what
//   `status.ts` maps to a folder state.
// - `CoreResolver.resolve` takes the folder's detection decision as a third
//   argument (`{mode, corePath}`); upstream has no bridged mode.
// - Upstream caches loaded installations and its tests assert object identity
//   for a shared one; this host loads nothing and caches nothing, so "the same
//   installation" is the same runtime key and a structurally equal record.
// - Upstream's "rejects a core package whose binary is missing" has no
//   host-side analogue (the binary is the worker's business). It is replaced
//   by the rejection this host actually performs: the SUPPORT_MATRIX version
//   floor. Same shape, same count, the check that exists here.
import * as assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Uri,
  workspace,
  type TextDocument,
  type WorkspaceFolder,
} from 'vscode';
import { CoreResolver } from '../../../src/stacks/lint/CoreResolver';
import {
  RslintResolutionError,
  resolveRslint,
} from '../../../src/stacks/lint/resolution';

// require.resolve can retain a Windows 8.3 alias (RUNNER~1) while fs.realpath
// returns its long spelling. Compare the physical identity used by production.
async function canonicalPath(filePath: string): Promise<string> {
  const realPath = path.normalize(await fs.realpath(filePath));
  return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
}

async function assertSamePhysicalPath(
  actual: string,
  expected: string,
): Promise<void> {
  assert.strictEqual(
    await canonicalPath(actual),
    await canonicalPath(expected),
  );
}

suite('local core resolver', () => {
  let temporaryDirectory: string;

  setup(async () => {
    temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'rslint-core-resolver-'),
    );
  });

  teardown(async function () {
    this.timeout(10_000);
    // Keep transient Windows EBUSY handling bounded and surface the final
    // failure instead of turning cleanup into a best-effort operation.
    await fs.rm(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  /**
   * The host-side half of upstream's `resolveCorePackageDirectory`: the
   * `@rslint/core` directory a document's own directory resolves, with the
   * `rstack.rslint.corePath` override applied relative to the folder root.
   */
  function resolveCoreDirectory(
    documentDirectory: string,
    corePath?: string,
  ): string {
    return resolveRslint({
      folderRoot: temporaryDirectory,
      mode: 'native',
      corePath,
      documentDirectory,
    }).coreDir;
  }

  function temporaryWorkspaceFolder(): WorkspaceFolder {
    return {
      uri: Uri.file(temporaryDirectory),
      name: 'temporary',
      index: 0,
    };
  }

  async function createSource(
    relativePath: string,
  ): Promise<Pick<TextDocument, 'uri'>> {
    const source = path.join(temporaryDirectory, relativePath);
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, 'const value = 1;\n');
    // Core resolution consumes only uri. A real VS Code TextDocument adds an
    // unrelated editor/file-watcher lifecycle and made Windows cleanup racy.
    return { uri: Uri.file(source) };
  }

  /**
   * Upstream's `createPackageDirectory` — a manifest is all the host reads.
   * Versions must clear the SUPPORT_MATRIX floor (`@rslint/core >= 0.8.0`)
   * wherever the test expects resolution to succeed.
   */
  async function createCore(
    packageDirectory: string,
    version: string,
  ): Promise<string> {
    await fs.mkdir(packageDirectory, { recursive: true });
    await fs.writeFile(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({ name: '@rslint/core', version }),
    );
    return packageDirectory;
  }

  async function createInstalledCore(
    root: string,
    version = '1.0.0',
  ): Promise<string> {
    return createCore(
      path.join(root, 'node_modules', '@rslint', 'core'),
      version,
    );
  }

  test('selects the nearest node_modules installation', async () => {
    const rootCore = await createInstalledCore(temporaryDirectory);
    const nestedRoot = path.join(temporaryDirectory, 'packages', 'app');
    const nestedCore = await createInstalledCore(nestedRoot);
    const sourceDirectory = path.join(nestedRoot, 'src');
    await fs.mkdir(sourceDirectory, { recursive: true });

    await assertSamePhysicalPath(
      resolveCoreDirectory(sourceDirectory),
      nestedCore,
    );
    assert.notStrictEqual(nestedCore, rootCore);
  });

  test('uses an explicit core package directory verbatim', async () => {
    // Deviation: upstream returns the configured path without touching the
    // filesystem (it loads the package afterwards). This host reads the
    // manifest to gate the version, so the directory must hold a real
    // `@rslint/core` — the assertion is still "exactly this directory".
    const configured = path.join(temporaryDirectory, 'vendor', 'rslint-core');
    await createCore(configured, '1.0.0');

    await assertSamePhysicalPath(
      resolveCoreDirectory(temporaryDirectory, configured),
      configured,
    );
  });

  test('loads a root installation for nested monorepo documents', async () => {
    const packageDirectory = await createInstalledCore(
      temporaryDirectory,
      '1.2.3',
    );
    const first = await createSource('packages/first/src/index.ts');
    const second = await createSource('packages/second/src/index.ts');

    const resolver = new CoreResolver();
    const [firstResolution, secondResolution] = await Promise.all([
      resolver.resolve(first, temporaryWorkspaceFolder(), { mode: 'native' }),
      resolver.resolve(second, temporaryWorkspaceFolder(), { mode: 'native' }),
    ]);

    // Shared installation: upstream asserts object identity out of its module
    // cache; here (no cache, see the header) it is the runtime key plus a
    // structurally equal installation.
    assert.strictEqual(firstResolution.key, secondResolution.key);
    assert.deepStrictEqual(
      firstResolution.installation,
      secondResolution.installation,
    );
    assert.strictEqual(firstResolution.installation.version, '1.2.3');
    await assertSamePhysicalPath(
      firstResolution.installation.packageDirectory,
      packageDirectory,
    );
  });

  test('selects independent nested installations for different documents', async () => {
    await Promise.all([
      createInstalledCore(
        path.join(temporaryDirectory, 'packages', 'first'),
        '1.0.0',
      ),
      createInstalledCore(
        path.join(temporaryDirectory, 'packages', 'second'),
        '2.0.0',
      ),
    ]);
    const first = await createSource('packages/first/src/index.ts');
    const second = await createSource('packages/second/src/index.ts');

    const resolver = new CoreResolver();
    const [firstResolution, secondResolution] = await Promise.all([
      resolver.resolve(first, temporaryWorkspaceFolder(), { mode: 'native' }),
      resolver.resolve(second, temporaryWorkspaceFolder(), { mode: 'native' }),
    ]);

    assert.notStrictEqual(firstResolution.key, secondResolution.key);
    assert.strictEqual(firstResolution.installation.version, '1.0.0');
    assert.strictEqual(secondResolution.installation.version, '2.0.0');
  });

  test('does not merge separate package copies by version text alone', async () => {
    await Promise.all([
      createInstalledCore(
        path.join(temporaryDirectory, 'packages', 'first'),
        '1.0.0',
      ),
      createInstalledCore(
        path.join(temporaryDirectory, 'packages', 'second'),
        '1.0.0',
      ),
    ]);
    const first = await createSource('packages/first/src/index.ts');
    const second = await createSource('packages/second/src/index.ts');

    const resolver = new CoreResolver();
    const [firstResolution, secondResolution] = await Promise.all([
      resolver.resolve(first, temporaryWorkspaceFolder(), { mode: 'native' }),
      resolver.resolve(second, temporaryWorkspaceFolder(), { mode: 'native' }),
    ]);

    assert.notStrictEqual(firstResolution.key, secondResolution.key);
    assert.notStrictEqual(
      firstResolution.installation,
      secondResolution.installation,
    );
  });

  test('loads an exact relative corePath outside node_modules', async () => {
    const packageDirectory = await createCore(
      path.join(temporaryDirectory, 'vendor', 'rslint-core'),
      '3.0.0',
    );
    const document = await createSource('src/index.ts');

    const resolved = await new CoreResolver().resolve(
      document,
      temporaryWorkspaceFolder(),
      { mode: 'native', corePath: 'vendor/rslint-core' },
    );

    await assertSamePhysicalPath(
      resolved.installation.packageDirectory,
      packageDirectory,
    );
    assert.strictEqual(resolved.installation.version, '3.0.0');
  });

  test('rejects a core package below the supported version floor', async () => {
    // Upstream's binary existence check, restated on the gate this host owns:
    // the resolver refuses an unusable core before any runtime is created, and
    // names the directory it came from (a folder can run several cores).
    // The status detail names the *physical* core directory, which is what the
    // resolver walked to (`/var` is a symlink to `/private/var` on macOS).
    const packageDirectory = path.normalize(
      await fs.realpath(await createInstalledCore(temporaryDirectory, '0.7.3')),
    );
    const document = await createSource('src/index.ts');

    await assert.rejects(
      new CoreResolver().resolve(document, temporaryWorkspaceFolder(), {
        mode: 'native',
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('0.7.3') &&
        error.message.includes(packageDirectory),
    );
  });

  test('does not execute a Yarn PnP resolver as a fallback', async () => {
    await fs.writeFile(
      path.join(temporaryDirectory, '.pnp.cjs'),
      'throw new Error("PnP resolver must not execute");\n',
    );

    assert.throws(
      () => resolveCoreDirectory(temporaryDirectory),
      (error: unknown) =>
        error instanceof RslintResolutionError && error.code === 'missing-core',
    );
  });

  test('reuses symlinks that point at one physical installation', async () => {
    const folder = workspace.workspaceFolders?.[0];
    assert.ok(folder, 'test requires a workspace folder');
    const actualCore = path.dirname(
      require.resolve('@rslint/core/package.json'),
    );
    const documents: Array<Pick<TextDocument, 'uri'>> = [];
    for (const name of ['a', 'b']) {
      const project = path.join(temporaryDirectory, name);
      const packageScope = path.join(project, 'node_modules', '@rslint');
      await fs.mkdir(packageScope, { recursive: true });
      await fs.symlink(
        actualCore,
        path.join(packageScope, 'core'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const source = path.join(project, 'index.ts');
      await fs.writeFile(source, `const ${name} = 1;\n`);
      documents.push({ uri: Uri.file(source) });
    }

    const resolver = new CoreResolver();
    const first = await resolver.resolve(documents[0], folder, {
      mode: 'native',
    });
    const second = await resolver.resolve(documents[1], folder, {
      mode: 'native',
    });
    assert.strictEqual(first.key, second.key);
    // Structural, not reference, equality — see the header on the cache.
    assert.deepStrictEqual(first.installation, second.installation);
    assert.strictEqual((first.installation.version ?? '').length > 0, true);
    // Upstream asserts an absolute `binaryPath`; the binary belongs to the
    // worker here, so the host's absolute path is the core directory.
    assert.strictEqual(
      path.isAbsolute(first.installation.packageDirectory),
      true,
    );
  });
});
