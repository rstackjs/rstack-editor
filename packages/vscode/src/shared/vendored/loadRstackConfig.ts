// TODO: revisit asking rstack-cli to export loadRstackConfig from the root entry.
// An official export would delete this vendored copy, whose globalThis session key is internal API.
//
// NOTE(rstack-bridge): the rslint bridge — this loader's main consumer — was
// deliberately removed; rebuilding it needs upstream work (rstack publishing an
// explicit-path config loader plus adapter exports, rslint accepting per-root
// fallback config candidates on `rslint/configRefresh`, and a generic
// evaluator-module seam shared by the config host and plugin workers). The
// formatter deliberately leaves `define.fmt()` evaluation to the CLI. This
// copy remains for the Rslint jiti preflight's `nativeTypeStrippingAvailable`
// probe and for direct loader unit coverage.
//
// Vendored from rstackjs/rstack-cli `packages/rstack/src/config.ts`
// (origin/main @ 6494ba2, rstack@0.3.2). Only three things differ from upstream:
//
// 1. the type imports of configs this extension does not care about are widened
//    to `unknown` so the extension does not depend on @rsbuild/@rslib/@rspress;
// 2. `loadRstackConfig` accepts a `cwd` and a `loader` in addition to
//    `configFilePath` — see the comment on `RstackConfigLoader`;
// 3. `define` is exported for completeness but is never used by the extension:
//    the user's own `rstack.config.*` imports `define` from *their* `rstack`
//    install. Interop is safe by construction because the session storage lives
//    on `globalThis` under the exact upstream key, so both module instances
//    share one active session.
//
// The `globalThis.__rstackConfigSessionStorage` key is internal API of
// rstack-cli. It must stay byte-identical to upstream — it is the entire
// interop mechanism.
import { AsyncLocalStorage } from 'node:async_hooks';
import { loadConfig } from '@rstackjs/load-config';
import type { RslintConfig } from '@rslint/core';
import type { RstestConfigExport } from '@rstest/core';

export type RslintConfigDefinition =
  RslintConfig | (() => Promise<RslintConfig>);

export type Configs = {
  /** `define.app` — an Rsbuild config; not consumed by the extension. */
  app?: unknown;
  /** `define.lib` — an Rslib config; not consumed by the extension. */
  lib?: unknown;
  /** `define.doc` — an Rspress config; not consumed by the extension. */
  doc?: unknown;
  test?: RstestConfigExport;
  lint?: RslintConfigDefinition;
  /** `define.fmt` — a Prettier config; consumed by `rs fmt` itself. */
  fmt?: unknown;
  /** `define.staged` — a lint-staged config; not consumed by the extension. */
  staged?: unknown;
};

export type LoadedRstackConfig = {
  configs: Configs;
  filePath: string | null;
  /**
   * Absolute paths of the statically imported relative dependencies of the
   * config file — usable as extra watch targets.
   */
  dependencies: string[];
};

/**
 * Divergence from upstream, deliberate and isolated: rstack-cli hardcodes
 * `loader: 'native'`, whose failure path rethrows instead of falling back to
 * jiti. The CLI runs on the user's Node (`engines.node >= 22.12`), but this
 * loader runs on the extension host's Node, whose version is fixed by VS Code.
 * On a host without native TypeScript type stripping, `'native'` hard-fails on
 * every `rstack.config.ts`, so the default here is `'auto'`.
 *
 * `'auto'` falls back to jiti, which has to be resolvable — see
 * `nativeTypeStrippingAvailable`, the preflight the caller is expected to use
 * for an actionable status bar hint.
 */
export type RstackConfigLoader = 'native' | 'auto';

export type LoadRstackConfigOptions = {
  /**
   * The path to the Rstack config file, can be a relative or absolute path.
   * If `configFilePath` is not provided, the config path set by the CLI is used.
   * If neither path is provided, the function will search for the config file in the current working directory.
   */
  configFilePath?: string;
  /**
   * Directory the default `rstack.config.*` probe runs in. Upstream never sets
   * it (the CLI relies on `process.cwd()`); the extension host's cwd is
   * meaningless, so a caller without an explicit `configFilePath` must pass it.
   */
  cwd?: string;
  loader?: RstackConfigLoader;
};

type ConfigSession = {
  configs: Configs;
  active: boolean;
};

type ConfigState = {
  configPath?: string;
};

declare global {
  // rslint-disable-next-line no-var
  var __rstackConfigSessionStorage:
    AsyncLocalStorage<ConfigSession> | undefined;
  // rslint-disable-next-line no-var
  var __rstackCliState: ConfigState | undefined;
}

const getConfigSessionStorage = (): AsyncLocalStorage<ConfigSession> => {
  // Rsbuild's fresh import loader can load this module more than once when it
  // imports the internal Rstack config. Keep the storage on globalThis so
  // every module instance reads and writes the same active session.
  if (!globalThis.__rstackConfigSessionStorage) {
    globalThis.__rstackConfigSessionStorage =
      new AsyncLocalStorage<ConfigSession>();
  }

  return globalThis.__rstackConfigSessionStorage;
};

export const getConfigState = (): ConfigState => {
  // The CLI and its internal tool config can also be loaded as separate module
  // instances. Keep only the CLI config path in its own global state.
  if (!globalThis.__rstackCliState) {
    globalThis.__rstackCliState = {};
  }

  return globalThis.__rstackCliState;
};

type Define = {
  app: (config: unknown) => void;
  lib: (config: unknown) => void;
  doc: (config: unknown) => void;
  test: (config: RstestConfigExport) => void;
  lint: (config: RslintConfigDefinition) => void;
  fmt: (config: unknown) => void;
  staged: (config: unknown) => void;
};

const setConfig = <T extends keyof Configs>(
  type: T,
  config: Configs[T],
): void => {
  const session = getConfigSessionStorage().getStore();

  if (!session?.active) {
    throw new Error(
      `The "${type}" config must be defined while loading an Rstack config.`,
    );
  }

  if (type in session.configs) {
    throw new Error(`The "${type}" config has already been defined.`);
  }
  session.configs[type] = config;
};

export const define: Define = {
  app: (config) => setConfig('app', config),
  lib: (config) => setConfig('lib', config),
  doc: (config) => setConfig('doc', config),
  test: (config) => setConfig('test', config),
  lint: (config) => setConfig('lint', config),
  fmt: (config) => setConfig('fmt', config),
  staged: (config) => setConfig('staged', config),
};

export const RSTACK_CONFIG_FILE_NAMES = [
  'rstack.config.ts',
  'rstack.config.js',
  'rstack.config.mts',
  'rstack.config.mjs',
];

export const loadRstackConfig = async ({
  configFilePath,
  cwd,
  loader = 'auto',
}: LoadRstackConfigOptions = {}): Promise<LoadedRstackConfig> => {
  const state = getConfigState();
  const configPath = configFilePath ?? state.configPath;
  const session: ConfigSession = {
    configs: {},
    active: true,
  };

  return getConfigSessionStorage().run(session, async () => {
    try {
      const { filePath, dependencies } = await loadConfig({
        loader,
        exportName: false,
        fresh: true,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(configPath !== undefined
          ? { path: configPath }
          : {
              configFileNames: RSTACK_CONFIG_FILE_NAMES,
            }),
      });

      return {
        configs: session.configs,
        filePath,
        dependencies,
      };
    } finally {
      session.active = false;
      session.configs = {};
    }
  });
};

/**
 * Preflight for the loader: when this is false, a `.ts`/`.mts` Rstack config
 * can only be loaded through jiti, and a missing jiti has to be surfaced as an
 * actionable hint instead of a generic config-load failure.
 *
 * Verified on a VS Code-class host (Node 20, no type stripping): loading a
 * `.ts` config through this loader ends in `@rstackjs/load-config`'s
 * `The "jiti" package is required to load this config.` — and because this
 * loader is *bundled into the extension*, its `import('jiti')` resolves from
 * the extension, not from the user's project. Installing jiti in the project
 * therefore does not fix it on its own. Callers must preflight with
 * `nativeTypeStrippingAvailable()` and show the hint below.
 */
export const nativeTypeStrippingAvailable = (): boolean =>
  Boolean((process.features as { typescript?: unknown }).typescript);

export const JITI_REQUIRED_HINT =
  'This VS Code build cannot strip TypeScript types, so an rstack.config.ts can only be loaded through jiti. Use rstack.config.mjs/js, or run VS Code on a Node build with type stripping.';

/**
 * Applies the logic of rstack-cli's `dist/rslintConfig.js` shim to a loaded
 * Rstack config. The Rslint path deliberately does not import that shim: it
 * would call `loadRstackConfig()` with no arguments inside the extension host,
 * whose cwd is meaningless.
 */
export const resolveRslintConfig = async (
  configs: Configs,
): Promise<RslintConfig> => {
  const lintExports = configs.lint ?? [];
  return typeof lintExports === 'function' ? await lintExports() : lintExports;
};
