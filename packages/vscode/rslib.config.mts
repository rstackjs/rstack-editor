import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type LibConfig, rspack } from '@rslib/core';
import WebpackLicensePlugin from 'webpack-license-plugin';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// The test stack's AST collection is the only native dependency in the VSIX.
// On musl Linux (Alpine), set `VSCE_TARGET=alpine-<arch>` explicitly.
const vsceTarget =
  process.env.VSCE_TARGET ?? `${process.platform}-${process.arch}`;
const LINUX_LIBC: Record<string, string> = { linux: 'gnu', alpine: 'musl' };
const [targetOs, targetArch] = vsceTarget.split('-');
const libc = LINUX_LIBC[targetOs];
const parserBindingSuffix = libc
  ? `linux-${targetArch}-${libc}`
  : targetOs === 'win32'
    ? `${vsceTarget}-msvc`
    : vsceTarget;
const parserRequire = createRequire(import.meta.resolve('@swc-next/parser'));
const parserBindingPackage = `@swc-next/parser-binding-${parserBindingSuffix}`;
const parserBindingPath = parserRequire.resolve(parserBindingPackage);

/**
 * Packages that are always resolved from the user's project at runtime, never
 * bundled: the extension ships types only.
 */
const RUNTIME_RESOLVED_PACKAGES = /^(@rslint\/core|@rstest\/core|jiti)(\/|$)/;

const externals: NonNullable<NonNullable<LibConfig['output']>['externals']> = [
  { vscode: 'commonjs vscode' },
  // Keep native package loading in Node; ship only the selected VSIX target.
  /^@swc-next\/parser-binding-/,
  ({ request }, callback) => {
    if (request && RUNTIME_RESOLVED_PACKAGES.test(request)) {
      return callback(undefined, `commonjs ${request}`);
    }
    return callback();
  },
];

// The Rstest worker entry is owned by the Rstest stack and may not exist yet
// while the stacks are still being copied in.
const workerEntry = './src/stacks/test/worker/index.ts';
const hasWorkerEntry = existsSync(path.join(rootDir, workerEntry));
const lintWorkerEntry = './src/stacks/lint/worker/main.ts';

const libs: LibConfig[] = [
  {
    id: 'extension',
    syntax: 'es2023',
    format: 'cjs',
    source: {
      entry: {
        extension: './src/extension.ts',
      },
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
                from: path.dirname(parserBindingPath),
                to: `node_modules/${parserBindingPackage}`,
              },
              {
                // Preloaded via a `--import` node arg, so a file of its own.
                from: path.join(
                  rootDir,
                  'src/shared/rstackResolveHookPreload.mjs',
                ),
                to: 'rstack-resolve-hook.mjs',
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
    id: 'worker',
    syntax: 'es2023',
    format: 'cjs',
    source: {
      entry: {
        worker: workerEntry,
      },
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

libs.push({
  id: 'lint-worker',
  syntax: 'es2023',
  format: 'cjs',
  source: {
    entry: {
      'lint-worker': lintWorkerEntry,
    },
  },
  tools: {
    rspack: {
      output: {
        devtoolModuleFilenameTemplate: '[absolute-resource-path]',
      },
    },
  },
});

/**
 * Output shared by every bundle. `rslib build --env-mode dev` (`build:local`
 * / `watch:local`) keeps readable output with source maps so breakpoints in
 * `src/` bind in the dev host; the release build (`build`, used by CI and the
 * Release workflow) minifies and emits no source maps.
 */
export default defineConfig(({ envMode }) => {
  const devBuild = envMode === 'dev';
  const output: LibConfig['output'] = {
    target: 'node',
    externals,
    sourceMap: devBuild,
    minify: !devBuild,
  };
  return {
    lib: libs.map((lib) => ({ ...lib, output })),
    tools: {
      rspack: (_, { appendPlugins, environment }) => {
        appendPlugins(
          new WebpackLicensePlugin({
            outputFilename: `${environment.name}.licenses.json`,
            includePackages: () =>
              environment.name === 'extension'
                ? [path.dirname(parserBindingPath)]
                : [],
          }),
        );
      },
    },
  };
});
