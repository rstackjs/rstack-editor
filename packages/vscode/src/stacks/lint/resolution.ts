import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Uri, workspace, type WorkspaceFolder } from 'vscode';
import { findPackageJsonUncached } from '../../shared/packageResolve';
import { readPackageVersion, SUPPORT_MATRIX } from '../../shared/versionCheck';
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
 *
 * Resolution walks physical `node_modules` only — no Yarn PnP, by decision,
 * matching upstream's resolver ("no PnP or fallback"); rationale in the
 * AGENTS.md gotchas. A PnP project surfaces the ordinary resolution failure,
 * whose message names the unsupported layout.
 */
export interface RslintResolution {
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

// `require.resolve` is rewritten by the bundler; `createRequire` is not. Every
// lookup passes an explicit `paths`/issuer, so the anchor itself is irrelevant.
const nodeRequire = createRequire(__filename);

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

/** Returns the path of the project's `@rslint/core/package.json`. */
const locateCore = (searchRoot: string, logger: Logger): string => {
  // Uncached on purpose: a failed root is retried after dependency changes
  // (the lockfile-driven detection pass), and `require.resolve` would replay
  // its process-lifetime cache instead of seeing a retargeted install. Every
  // cooperating piece resolves from the returned path afterwards, so the
  // whole root follows the fresh location (the one-resolution-root rule).
  const packageJsonPath = findPackageJsonUncached('@rslint/core', searchRoot);
  if (packageJsonPath !== undefined) {
    logger.debug(`Found @rslint/core: ${packageJsonPath}`);
    return packageJsonPath;
  }

  // Diagnostic only, never a resolution branch: under Yarn PnP the usual
  // remedy (installing @rslint/core as a devDependency) writes no physical
  // `node_modules`, so the message must name the layout as the blocker.
  const usesPnp = ['.pnp.cjs', '.pnp.js'].some((name) =>
    fs.existsSync(path.join(searchRoot, name)),
  );
  throw new RslintResolutionError(
    usesPnp
      ? `Could not resolve @rslint/core from ${searchRoot}: this project uses Yarn Plug'n'Play, which this extension does not support — switch to nodeLinker: node-modules to lint in the editor.`
      : `Could not resolve @rslint/core from ${searchRoot}. This extension ships no Rslint binary — install @rslint/core in the project (this extension requires ${SUPPORT_MATRIX['@rslint/core']}).`,
  );
};

const resolveCoreSubpath = (
  packageJsonPath: string,
  coreDir: string,
  subpath: string,
): string => {
  const specifier = `@rslint/core/${subpath}`;
  try {
    // Node's self-reference resolution: a request issued from inside the
    // package resolves against that package's own `exports` map, which pins
    // the answer to this exact install rather than to whatever copy a
    // node_modules walk-up would find first.
    return createRequire(packageJsonPath).resolve(specifier);
  } catch (error) {
    try {
      return nodeRequire.resolve(specifier, { paths: [coreDir] });
    } catch {
      throw new RslintResolutionError(
        `Could not resolve ${specifier} from ${coreDir}. Rslint ${SUPPORT_MATRIX['@rslint/core']} is required (its package exports ./config-loader and ./eslint-plugin).`,
        { cause: error },
      );
    }
  }
};

const resolveNativeBinary = (coreDir: string, logger: Logger): string => {
  // Try each platform-package candidate in order, using the first that
  // resolves (linux ships gnu/musl variants — only one is installed).
  for (const request of getPlatformBinRequests()) {
    try {
      const binPath = nodeRequire.resolve(request, { paths: [coreDir] });
      logger.debug(`Using Rslint binary from the project: ${binPath}`);
      return binPath;
    } catch {
      // Candidate not installed; try the next one.
    }
  }
  throw new RslintResolutionError(
    `Could not resolve the Rslint native binary (${getPlatformBinRequests().join(
      ' or ',
    )}) from ${coreDir}. The @rslint/native-* package for this platform is not installed.`,
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
 * Binary resolution order: explicit setting → workspace `node_modules`.
 * `@rslint/core`'s JS entry points always come from the project, because the
 * LSP is useless without a config-loader host.
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

  const packageJsonPath = locateCore(folder.uri.fsPath, logger);
  const coreDir = path.dirname(packageJsonPath);
  const configLoaderPath = resolveCoreSubpath(
    packageJsonPath,
    coreDir,
    'config-loader',
  );
  const eslintPluginPath = resolveCoreSubpath(
    packageJsonPath,
    coreDir,
    'eslint-plugin',
  );
  assertSingleResolutionRoot(coreDir, [
    { label: '@rslint/core/config-loader', path: configLoaderPath },
    { label: '@rslint/core/eslint-plugin', path: eslintPluginPath },
  ]);

  const binFromUserSetting = binPathConfig === 'custom';
  const binPath = binFromUserSetting
    ? await resolveUserBinary(folder, logger)
    : resolveNativeBinary(coreDir, logger);

  if (binFromUserSetting) {
    // The user explicitly waived the one-root invariant for the binary only.
    // Say so loudly: a binary/loader protocol drift shows up here first.
    logger.warn(
      `Rslint binary comes from rstack.rslint.customBinPath (${binPath}) while the config-loader comes from ${coreDir}. The single-resolution-root invariant is waived by this explicit setting.`,
    );
  }

  return {
    coreDir,
    coreVersion: readPackageVersion(packageJsonPath),
    binPath,
    binFromUserSetting,
    configLoaderPath,
    eslintPluginPath,
  };
};
