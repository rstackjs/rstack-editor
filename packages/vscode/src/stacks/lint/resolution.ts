import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Uri, workspace, type WorkspaceFolder } from 'vscode';
import { findPackageJsonUncached } from '../../shared/packageResolve';
import type { Logger } from './logger';
import {
  fileExists,
  getPlatformBinRequests,
  type RslintBinPath,
} from './utils';

/**
 * Everything Rslint-related is resolved from the *user's project*: this
 * extension ships no Go binary and no `@rslint/core`. The
 * `built-in` mode is gone, so a failed resolution is a hard, user-visible
 * failure — never a silent fallback.
 *
 * There must additionally be **one resolution root**: the Go binary,
 * `@rslint/core/config-loader` and `@rslint/core/eslint-plugin` must all come
 * from the same `@rslint/core` install, "never binary from A, loader from B".
 * `assertSingleResolutionRoot` enforces that as an assertion, not a
 * convention.
 */
export type RslintResolutionKind = 'node-modules' | 'pnp';

export interface RslintResolution {
  /** How `@rslint/core` itself was found. */
  readonly kind: RslintResolutionKind;
  /** The single resolution root: the directory of the project's `@rslint/core`. */
  readonly coreDir: string;
  readonly coreVersion: string | undefined;
  /** The Go language server executable. */
  readonly binPath: string;
  /** True when `binPath` came from `rstack.rslint.customBinPath`. */
  readonly binFromUserSetting: boolean;
  /** Absolute path of the project's `@rslint/core/config-loader` entry. */
  readonly configLoaderPath: string;
  /** Absolute path of the project's `@rslint/core/eslint-plugin` entry. */
  readonly eslintPluginPath: string;
}

/** A resolution failure that must surface in the status bar. */
export class RslintResolutionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RslintResolutionError';
  }
}

interface PnpApi {
  resolveRequest(request: string, issuer: string): string | null;
}

// `require.resolve` is rewritten by the bundler; `createRequire` is not. Every
// lookup passes an explicit `paths`/issuer, so the anchor itself is irrelevant.
const nodeRequire = createRequire(__filename);

const readPackageVersion = (packageJsonPath: string): string | undefined => {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(packageJsonPath, 'utf8'),
    ) as unknown;
    if (raw && typeof raw === 'object' && 'version' in raw) {
      const version = (raw as { version?: unknown }).version;
      return typeof version === 'string' ? version : undefined;
    }
  } catch {
    // A malformed package.json is reported by the version check as `unknown`.
  }
  return undefined;
};

const isInside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
};

/**
 * The one-resolution-root rule is enforced as an assertion, not a
 * convention: both JS entry points must live inside the very `@rslint/core`
 * whose native binary we are about to spawn.
 */
export const assertSingleResolutionRoot = (
  coreDir: string,
  entries: ReadonlyArray<{ readonly label: string; readonly path: string }>,
): void => {
  for (const entry of entries) {
    if (!isInside(entry.path, coreDir)) {
      throw new RslintResolutionError(
        `Rslint resolution root mismatch: ${entry.label} resolved to ${entry.path}, which is outside the resolved @rslint/core at ${coreDir}`,
      );
    }
  }
};

const loadPnpApi = async (folder: WorkspaceFolder): Promise<PnpApi | null> => {
  for (const extension of ['cjs', 'js']) {
    const pnpFile = Uri.joinPath(folder.uri, `.pnp.${extension}`);
    if (!(await fileExists(pnpFile))) {
      continue;
    }
    try {
      return nodeRequire(pnpFile.fsPath) as PnpApi;
    } catch {
      // Try the next candidate; a broken PnP file is not fatal on its own.
    }
  }
  return null;
};

interface CoreLocation {
  readonly kind: RslintResolutionKind;
  readonly packageJsonPath: string;
  readonly coreDir: string;
  readonly pnpApi?: PnpApi;
}

const locateCore = async (
  folder: WorkspaceFolder,
  logger: Logger,
): Promise<CoreLocation> => {
  const searchRoot = folder.uri.fsPath;
  // Uncached on purpose: a failed root is retried after dependency changes
  // (the lockfile-driven detection pass), and `require.resolve` would replay
  // its process-lifetime cache instead of seeing a retargeted install. Every
  // cooperating piece resolves from the returned path afterwards, so the
  // whole root follows the fresh location (the one-resolution-root rule).
  const packageJsonPath = findPackageJsonUncached('@rslint/core', searchRoot);
  if (packageJsonPath !== undefined) {
    logger.debug(`Found @rslint/core in node_modules: ${packageJsonPath}`);
    return {
      kind: 'node-modules',
      packageJsonPath,
      coreDir: path.dirname(packageJsonPath),
    };
  }
  logger.debug('No @rslint/core in node_modules, trying Yarn PnP');

  const pnpApi = await loadPnpApi(folder);
  if (pnpApi) {
    try {
      const packageJsonPath = pnpApi.resolveRequest(
        '@rslint/core/package.json',
        searchRoot,
      );
      if (packageJsonPath) {
        logger.debug(`Found @rslint/core in PnP: ${packageJsonPath}`);
        return {
          kind: 'pnp',
          packageJsonPath,
          coreDir: path.dirname(packageJsonPath),
          pnpApi,
        };
      }
    } catch {
      // Fall through to the shared failure below.
    }
  }

  throw new RslintResolutionError(
    `Could not resolve @rslint/core from ${searchRoot}. This extension ships no Rslint binary — install @rslint/core in the project (this extension requires >= 0.7.2).`,
  );
};

const resolveCoreSubpath = (
  location: CoreLocation,
  subpath: string,
): string => {
  const specifier = `@rslint/core/${subpath}`;
  if (location.pnpApi) {
    const resolved = location.pnpApi.resolveRequest(
      specifier,
      location.packageJsonPath,
    );
    if (!resolved) {
      throw new RslintResolutionError(
        `Could not resolve ${specifier} through Yarn PnP from ${location.coreDir}`,
      );
    }
    return resolved;
  }
  try {
    // Node's self-reference resolution: a request issued from inside the
    // package resolves against that package's own `exports` map, which pins
    // the answer to this exact install rather than to whatever copy a
    // node_modules walk-up would find first.
    return createRequire(location.packageJsonPath).resolve(specifier);
  } catch (error) {
    try {
      return nodeRequire.resolve(specifier, { paths: [location.coreDir] });
    } catch {
      throw new RslintResolutionError(
        `Could not resolve ${specifier} from ${location.coreDir}. Rslint >= 0.7.2 is required (its package exports ./config-loader and ./eslint-plugin).`,
        { cause: error },
      );
    }
  }
};

const resolveNativeBinary = (
  location: CoreLocation,
  logger: Logger,
): string => {
  // Try each platform-package candidate in order, using the first that
  // resolves (linux ships gnu/musl variants — only one is installed).
  for (const request of getPlatformBinRequests()) {
    try {
      const binPath = location.pnpApi
        ? // PnP's resolveRequest throws (rather than returning null) for a
          // candidate absent from the dependency map, so each lookup needs its
          // own try/catch to fall through to the next tuple.
          location.pnpApi.resolveRequest(request, location.packageJsonPath)
        : nodeRequire.resolve(request, { paths: [location.coreDir] });
      if (binPath) {
        logger.debug(`Using Rslint binary from the project: ${binPath}`);
        return binPath;
      }
    } catch {
      // Candidate not installed; try the next one.
    }
  }
  throw new RslintResolutionError(
    `Could not resolve the Rslint native binary (${getPlatformBinRequests().join(
      ' or ',
    )}) from ${location.coreDir}. The @rslint/native-* package for this platform is not installed.`,
  );
};

const resolveUserBinary = async (
  folder: WorkspaceFolder,
  logger: Logger,
): Promise<string> => {
  const customBinPath = workspace
    .getConfiguration('rstack.rslint', folder.uri)
    .get<string>('customBinPath')
    ?.trim();

  if (!customBinPath) {
    throw new RslintResolutionError(
      '`rstack.rslint.binPath` is set to "custom" but `rstack.rslint.customBinPath` is not configured',
    );
  }
  logger.debug(
    `Try using Rslint binary path from user settings: ${customBinPath}`,
  );
  if (!(await fileExists(Uri.file(customBinPath)))) {
    throw new RslintResolutionError(
      `Rslint binary path from user settings does not exist: ${customBinPath}`,
    );
  }
  logger.debug(`Using Rslint binary from user settings: ${customBinPath}`);
  return customBinPath;
};

/**
 * Binary resolution order: explicit setting → workspace
 * `node_modules` → Yarn PnP. `@rslint/core`'s JS entry points always come from
 * the project, because the LSP is useless without a config-loader host.
 */
export const resolveRslint = async (
  folder: WorkspaceFolder,
  logger: Logger,
): Promise<RslintResolution> => {
  const binPathConfig = workspace
    .getConfiguration('rstack.rslint', folder.uri)
    .get<RslintBinPath>('binPath', 'local');

  if (binPathConfig !== 'local' && binPathConfig !== 'custom') {
    throw new RslintResolutionError(
      `Unsupported rstack.rslint.binPath setting: ${String(binPathConfig)}`,
    );
  }

  const location = await locateCore(folder, logger);
  const configLoaderPath = resolveCoreSubpath(location, 'config-loader');
  const eslintPluginPath = resolveCoreSubpath(location, 'eslint-plugin');
  assertSingleResolutionRoot(location.coreDir, [
    { label: '@rslint/core/config-loader', path: configLoaderPath },
    { label: '@rslint/core/eslint-plugin', path: eslintPluginPath },
  ]);

  const binFromUserSetting = binPathConfig === 'custom';
  const binPath = binFromUserSetting
    ? await resolveUserBinary(folder, logger)
    : resolveNativeBinary(location, logger);

  if (binFromUserSetting) {
    // The user explicitly waived the one-root invariant for the binary only.
    // Say so loudly: a binary/loader protocol drift shows up here first.
    logger.warn(
      `Rslint binary comes from rstack.rslint.customBinPath (${binPath}) while the config-loader comes from ${location.coreDir}. The single-resolution-root invariant is waived by this explicit setting.`,
    );
  }

  return {
    kind: location.kind,
    coreDir: location.coreDir,
    coreVersion: readPackageVersion(location.packageJsonPath),
    binPath,
    binFromUserSetting,
    configLoaderPath,
    eslintPluginPath,
  };
};
