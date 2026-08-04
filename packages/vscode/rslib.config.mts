import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type LibConfig, rspack } from '@rslib/core';

const require = createRequire(import.meta.url);
const rootDir = path.dirname(fileURLToPath(import.meta.url));

// The VSIX is platform-targeted for exactly one reason: Rstest's AST test-case
// collection loads the `yuku-parser` napi binding. Everything else in this
// extension is platform neutral (the Rslint Go binary and its napi parser are
// resolved from the project at runtime and never ship in the VSIX).
const vsceTarget =
  process.env.VSCE_TARGET ?? `${process.platform}-${process.arch}`;
// The Linux VSIX targets use glibc, whose Yuku bindings have a `-gnu` suffix.
const yukuBindingSuffix = vsceTarget.startsWith('linux-')
  ? `${vsceTarget}-gnu`
  : vsceTarget;
const yukuRequire = createRequire(require.resolve('yuku-parser'));
// Yuku computes this package name at runtime, so Rspack cannot discover it.
const yukuBindingPath = yukuRequire.resolve(
  `@yuku-parser/binding-${yukuBindingSuffix}`,
);

/**
 * Packages that are always resolved from the user's project at runtime, never
 * bundled: the extension ships types only.
 */
const RUNTIME_RESOLVED_PACKAGES = /^(@rslint\/core|@rstest\/core|jiti)(\/|$)/;

const externals: NonNullable<NonNullable<LibConfig['output']>['externals']> = [
  { vscode: 'commonjs vscode' },
  ({ request }, callback) => {
    if (request && RUNTIME_RESOLVED_PACKAGES.test(request)) {
      return callback(undefined, `commonjs ${request}`);
    }
    return callback();
  },
];

const sourceMap = process.env.SOURCEMAP === 'true';

// The Rstest worker entry is owned by the Rstest stack and may not exist yet
// while the stacks are still being copied in.
const workerEntry = './src/stacks/test/worker/index.ts';
const hasWorkerEntry = existsSync(path.join(rootDir, workerEntry));

const libs: LibConfig[] = [
  {
    syntax: 'es2023',
    format: 'cjs',
    source: {
      entry: {
        extension: './src/extension.ts',
      },
    },
    output: {
      target: 'node',
      externals,
      sourceMap,
    },
    tools: {
      rspack: {
        output: {
          devtoolModuleFilenameTemplate: '[absolute-resource-path]',
        },
        plugins: [
          new rspack.CopyRspackPlugin({
            patterns: [
              {
                from: yukuBindingPath,
                to: `@yuku-parser/binding-${yukuBindingSuffix}/yuku-parser.node`,
              },
              {
                // The VSIX must carry a LICENSE (`.vscodeignore` keeps it), and
                // the workspace root LICENSE is the single source of truth. The
                // copy lands next to package.json — not in dist/ — because vsce
                // packages from the package directory; it is gitignored.
                from: path.join(rootDir, '..', '..', 'LICENSE'),
                to: path.join(rootDir, 'LICENSE'),
                toType: 'file',
              },
            ],
          }),
        ],
      },
    },
  },
];

if (hasWorkerEntry) {
  libs.push({
    syntax: 'es2023',
    format: 'cjs',
    source: {
      entry: {
        worker: workerEntry,
      },
    },
    output: {
      target: 'node',
      externals,
      sourceMap,
    },
    tools: {
      rspack: {
        output: {
          devtoolModuleFilenameTemplate: '[absolute-resource-path]',
        },
      },
    },
  });
}

export default defineConfig({ lib: libs });
