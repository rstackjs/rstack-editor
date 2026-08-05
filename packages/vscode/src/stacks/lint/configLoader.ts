import type {
  ConfigModuleHost,
  ConfigModuleHostOptions,
} from '@rslint/core/config-loader';
import type { createPluginLintHost } from '@rslint/core/eslint-plugin';
import {
  formatProtocolVersionMismatch,
  isSupportedConfigDiscoveryProtocolVersion,
} from '../../shared/versionCheck';
import { importProjectModule } from './projectModules';
import type { RslintResolution } from './resolution';

/**
 * `@rslint/core/config-loader` is **not bundled**: the types are
 * `import type` only and the runtime value comes from the project-resolved
 * module, loaded from the same root as the Go binary.
 */
export interface ConfigLoaderModule {
  readonly CONFIG_DISCOVERY_PROTOCOL_VERSION: number;
  readonly ConfigModuleHost: new (
    options?: ConfigModuleHostOptions,
  ) => ConfigModuleHost;
}

/** The `@rslint/core/eslint-plugin` surface `PluginLintPool` depends on. */
export interface EslintPluginModule {
  readonly createPluginLintHost: typeof createPluginLintHost;
}

/**
 * The config-discovery protocol between the Go server and the JS loader is
 * versioned independently of the package version, so `semver.satisfies` is
 * necessary but not sufficient. A mismatch is surfaced as the
 * `version mismatch` status-bar state.
 */
export class ConfigDiscoveryProtocolMismatchError extends Error {
  constructor(readonly protocolVersion: number) {
    super(formatProtocolVersionMismatch(protocolVersion));
    this.name = 'ConfigDiscoveryProtocolMismatchError';
  }
}

const isConfigLoaderModule = (value: unknown): value is ConfigLoaderModule =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as ConfigLoaderModule).CONFIG_DISCOVERY_PROTOCOL_VERSION ===
    'number' &&
  typeof (value as ConfigLoaderModule).ConfigModuleHost === 'function';

/**
 * Loads the project's config-loader and performs the protocol handshake.
 *
 * The `protocolVersion` this returns is the exact value the client then puts
 * into every `rslint/configRefresh` request and validates on every
 * server-initiated config transaction, so the Go server and the JS loader can
 * never silently disagree.
 */
export const loadConfigLoaderModule = async (
  resolution: RslintResolution,
): Promise<ConfigLoaderModule> => {
  const module = await importProjectModule<unknown>(
    resolution.configLoaderPath,
  );
  if (!isConfigLoaderModule(module)) {
    throw new Error(
      `${resolution.configLoaderPath} does not export the expected config-loader surface (CONFIG_DISCOVERY_PROTOCOL_VERSION, ConfigModuleHost)`,
    );
  }
  if (
    !isSupportedConfigDiscoveryProtocolVersion(
      module.CONFIG_DISCOVERY_PROTOCOL_VERSION,
    )
  ) {
    throw new ConfigDiscoveryProtocolMismatchError(
      module.CONFIG_DISCOVERY_PROTOCOL_VERSION,
    );
  }
  return module;
};

const isEslintPluginModule = (value: unknown): value is EslintPluginModule =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as EslintPluginModule).createPluginLintHost === 'function';

/**
 * Loads the project's ESLint-plugin host. Verified to work unpatched from a
 * plain project install (a verified non-requirement): the host spawns its
 * sibling `lint-worker.js` and the worker finds `@rslint/native-*` by
 * node_modules walk-up, all inside the project.
 */
export const loadEslintPluginModule = async (
  resolution: RslintResolution,
): Promise<EslintPluginModule> => {
  const module = await importProjectModule<unknown>(
    resolution.eslintPluginPath,
  );
  if (!isEslintPluginModule(module)) {
    throw new Error(
      `${resolution.eslintPluginPath} does not export createPluginLintHost`,
    );
  }
  return module;
};
