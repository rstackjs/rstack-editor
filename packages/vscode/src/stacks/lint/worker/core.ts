import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ConfigModuleHost,
  ConfigModuleHostOptions,
} from '@rslint/core/config-loader';
import type { createPluginLintHost } from '@rslint/core/eslint-plugin';

const CORE_PACKAGE_NAME = '@rslint/core';

type ConfigModuleHostConstructor = new (
  options?: ConfigModuleHostOptions,
) => ConfigModuleHost;

interface ConfigLoaderModule {
  readonly ConfigModuleHost: ConfigModuleHostConstructor;
  readonly CONFIG_DISCOVERY_PROTOCOL_VERSION: number;
  readonly resolveRslintBinary: () => unknown;
}

interface PluginHostModule {
  readonly createPluginLintHost: typeof createPluginLintHost;
}

interface CorePackageJson {
  readonly version: string;
}

export interface CoreInstallation {
  readonly packageDirectory: string;
  readonly version: string;
  readonly binaryPath: string;
  readonly protocolVersion: number;
  createConfigModuleHost(): ConfigModuleHost;
  createPluginLintHost: typeof createPluginLintHost;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isConfigLoaderModule(value: unknown): value is ConfigLoaderModule {
  return (
    isRecord(value) &&
    typeof value.ConfigModuleHost === 'function' &&
    Number.isInteger(value.CONFIG_DISCOVERY_PROTOCOL_VERSION) &&
    typeof value.resolveRslintBinary === 'function'
  );
}

function isPluginHostModule(value: unknown): value is PluginHostModule {
  return isRecord(value) && typeof value.createPluginLintHost === 'function';
}

async function readPackageJson(
  packageDirectory: string,
): Promise<CorePackageJson> {
  const packageJsonPath = path.join(packageDirectory, 'package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Could not read ${packageJsonPath}`, { cause: error });
  }
  if (
    !isRecord(parsed) ||
    parsed.name !== CORE_PACKAGE_NAME ||
    typeof parsed.version !== 'string' ||
    parsed.version.length === 0
  ) {
    throw new Error(
      `${packageJsonPath} is not a valid ${CORE_PACKAGE_NAME} package`,
    );
  }
  return { version: parsed.version };
}

function resolveExport(packageDirectory: string, subpath: string): string {
  const packageJsonPath = path.join(packageDirectory, 'package.json');
  try {
    return createRequire(packageJsonPath).resolve(
      `${CORE_PACKAGE_NAME}/${subpath}`,
    );
  } catch (error) {
    throw new Error(
      `${CORE_PACKAGE_NAME} does not provide the required ./${subpath} export`,
      { cause: error },
    );
  }
}

async function loadModule(modulePath: string): Promise<unknown> {
  return import(pathToFileURL(modulePath).href) as Promise<unknown>;
}

export async function loadCoreInstallation(
  packageDirectory: string,
): Promise<CoreInstallation> {
  const packageJson = await readPackageJson(packageDirectory);
  const configLoaderPath = resolveExport(packageDirectory, 'config-loader');
  const pluginHostPath = resolveExport(packageDirectory, 'eslint-plugin');
  const configLoaderModule = await loadModule(configLoaderPath);
  if (!isConfigLoaderModule(configLoaderModule)) {
    throw new Error(
      `${CORE_PACKAGE_NAME}/config-loader has an incompatible module shape`,
    );
  }

  const binaryPath = configLoaderModule.resolveRslintBinary();
  if (typeof binaryPath !== 'string' || binaryPath.length === 0) {
    throw new Error(
      `${CORE_PACKAGE_NAME}/config-loader returned an invalid binary path`,
    );
  }
  const binaryStat = await fs.stat(binaryPath).catch((error: unknown) => {
    throw new Error(`Rslint binary does not exist at ${binaryPath}`, {
      cause: error,
    });
  });
  if (!binaryStat.isFile()) {
    throw new Error(`Rslint binary is not a file: ${binaryPath}`);
  }

  let pluginFactoryPromise: Promise<typeof createPluginLintHost> | undefined;
  const getPluginFactory = async (): Promise<typeof createPluginLintHost> => {
    pluginFactoryPromise ??= loadModule(pluginHostPath).then((module) => {
      if (!isPluginHostModule(module)) {
        throw new Error(
          `${CORE_PACKAGE_NAME}/eslint-plugin has an incompatible module shape`,
        );
      }
      return module.createPluginLintHost;
    });
    try {
      return await pluginFactoryPromise;
    } catch (error) {
      pluginFactoryPromise = undefined;
      throw error;
    }
  };

  return {
    packageDirectory,
    version: packageJson.version,
    binaryPath,
    protocolVersion: configLoaderModule.CONFIG_DISCOVERY_PROTOCOL_VERSION,
    createConfigModuleHost: () => new configLoaderModule.ConfigModuleHost(),
    createPluginLintHost: async (...args) => {
      const factory = await getPluginFactory();
      return factory(...args);
    },
  };
}
