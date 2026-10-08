import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type LibConfig, rspack } from '@rslib/core';
import WebpackLicensePlugin from 'webpack-license-plugin';

const require = createRequire(import.meta.url);
const rootDir = path.dirname(fileURLToPath(import.meta.url));

// The VSIX is platform-targeted for exactly one reason: Rstest's AST test-case
// collection loads the `yuku-parser` napi binding. Everything else in this
// extension is platform neutral (the Rslint Go binary and its napi parser are
// resolved from the project at runtime and never ship in the VSIX).
// On musl Linux (Alpine), set `VSCE_TARGET=alpine-<arch>` explicitly.
const vsceTarget =
  process.env.VSCE_TARGET ?? `${process.platform}-${process.arch}`;
// Yuku's loader resolves `binding-${platform}-${arch}${libc}`; the Linux VSIX
// targets differ only by libc: `linux-*` is glibc, `alpine-*` is musl.
const LINUX_LIBC: Record<string, string> = { linux: 'gnu', alpine: 'musl' };
const [targetOs, targetArch] = vsceTarget.split('-');
const libc = LINUX_LIBC[targetOs];
const yukuBindingSuffix = libc ? `linux-${targetArch}-${libc}` : vsceTarget;
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
                ? [path.dirname(yukuBindingPath)]
                : [],
          }),
        );
      },
    },
  };
});
