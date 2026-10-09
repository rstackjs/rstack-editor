import fs from 'node:fs';
import path from 'node:path';
import {
  findPackageJsonUncached,
  readPackageJson,
} from '../../shared/packageResolve';

export type RslintMode = 'native' | 'bridged';

export interface RslintResolution {
  readonly mode: RslintMode;
  readonly coreDir: string;
  readonly coreVersion: string | undefined;
  readonly rstackDir?: string;
  readonly rstackVersion?: string;
  readonly shimPath?: string;
}

export type RslintResolutionErrorCode =
  'missing-rstack' | 'missing-core' | 'invalid-package' | 'missing-shim';

export class RslintResolutionError extends Error {
  /**
   * The package whose absence caused this failure — set only by the
   * not-installed throws (`resolveInstalledPackage`), the state the three
   * stacks report uniformly (AGENTS.md). `missing-shim` and
   * `invalid-package` leave it unset on purpose: there the package is
   * present and the fix is an upgrade or the setting, not an install.
   */
  readonly missingPackage?: 'rstack' | '@rslint/core';

  constructor(
    readonly code: RslintResolutionErrorCode,
    message: string,
    options?: { cause?: unknown; missingPackage?: 'rstack' | '@rslint/core' },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'RslintResolutionError';
    this.missingPackage = options?.missingPackage;
  }
}

/** Upstream's discovery order within one directory (rslint `config_init.go`). */
export const RSLINT_CONFIG_NAMES = [
  'rslint.config.js',
  'rslint.config.mjs',
  'rslint.config.ts',
  'rslint.config.mts',
] as const;

const hasNodeModulesSegment = (directory: string): boolean =>
  directory.split(/[\\/]/).includes('node_modules');

/**
 * The strict ancestors of `folderPath`, nearest first, up to the filesystem
 * root. Directories under a `node_modules` segment are skipped, as Go's
 * `isDefaultDiscoveryExcluded` skips their config candidates.
 */
export function ancestorDirectories(folderPath: string): string[] {
  const directories: string[] = [];
  let directory = path.resolve(folderPath);
  for (;;) {
    const parent = path.dirname(directory);
    if (parent === directory) return directories;
    directory = parent;
    if (!hasNodeModulesSegment(directory)) directories.push(directory);
  }
}

const isFileSync = (filePath: string): boolean => {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

/**
 * The nearest `rslint.config.*` above the workspace folder: the config the Go
 * server's upward discovery (`findCandidateUp`) loads for a folder that has
 * none of its own.
 */
export function findAncestorRslintConfig(
  folderPath: string,
  isFile: (filePath: string) => boolean = isFileSync,
): string | undefined {
  for (const directory of ancestorDirectories(folderPath)) {
    for (const name of RSLINT_CONFIG_NAMES) {
      const candidate = path.join(directory, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface RslintModeSignals {
  readonly nativeConfigPaths: readonly string[];
  readonly rootRstackConfigPath?: string;
  /** A native config above the folder, for a folder with no config of its own. */
  readonly ancestorConfigPath?: string;
}

/**
 * Native ownership wins; only a root Rstack config can bridge a folder. A
 * native config above the folder ranks below that root Rstack config, so it
 * never turns a bridged folder native.
 */
export function decideRslintMode({
  nativeConfigPaths,
  rootRstackConfigPath,
  ancestorConfigPath,
}: RslintModeSignals): RslintMode | undefined {
  if (nativeConfigPaths.length > 0) return 'native';
  if (rootRstackConfigPath !== undefined) return 'bridged';
  if (ancestorConfigPath !== undefined) return 'native';
  return undefined;
}

interface PackageLocation {
  readonly directory: string;
  readonly version: string | undefined;
}

function readPackageLocation(
  packageName: 'rstack' | '@rslint/core',
  packageJsonPath: string,
): PackageLocation {
  const pkg = readPackageJson(packageJsonPath);
  if (pkg?.name !== packageName) {
    throw new RslintResolutionError(
      'invalid-package',
      `${packageJsonPath} is not a valid ${packageName} package`,
    );
  }
  // Upstream's CoreResolver refuses a package without a version string. Here
  // an unknown version soft-passes the floor instead (`shared/versionCheck.ts`,
  // the toolchain-wide policy), so only the name is a hard requirement.
  return {
    directory: path.dirname(packageJsonPath),
    version: typeof pkg.version === 'string' ? pkg.version : undefined,
  };
}

function resolveConfiguredCore(
  folderRoot: string,
  configuredPath: string,
): PackageLocation {
  const resolvedPath = path.resolve(folderRoot, configuredPath);
  const packageJsonPath = configuredPath.endsWith('package.json')
    ? resolvedPath
    : path.join(resolvedPath, 'package.json');
  const directory = path.dirname(packageJsonPath);
  try {
    if (!fs.statSync(packageJsonPath).isFile()) throw new Error('not a file');
  } catch (error) {
    // Not `missing-core`: the user pointed `corePath` at this directory, so
    // the fix is correcting the setting, not installing dependencies — it must
    // not take the not-installed state (`missingPackageOf`).
    throw new RslintResolutionError(
      'invalid-package',
      `Could not access @rslint/core at ${directory}`,
      { cause: error },
    );
  }
  return readPackageLocation('@rslint/core', fs.realpathSync(packageJsonPath));
}

function resolveInstalledPackage(
  packageName: 'rstack' | '@rslint/core',
  searchRoot: string,
  code: Extract<RslintResolutionErrorCode, 'missing-rstack' | 'missing-core'>,
): PackageLocation {
  const packageJsonPath = findPackageJsonUncached(packageName, searchRoot);
  if (packageJsonPath === undefined) {
    throw new RslintResolutionError(
      code,
      `Could not resolve ${packageName} from ${searchRoot}`,
      { missingPackage: packageName },
    );
  }
  return readPackageLocation(packageName, packageJsonPath);
}

export interface ResolveRslintOptions {
  readonly folderRoot: string;
  readonly mode: RslintMode;
  readonly corePath?: string;
  /**
   * Where the native walk-up starts (per-document resolution, rslint #1617);
   * defaults to the folder root. Bridged mode starts at rstack's directory
   * instead — one config choice per folder, ADR 0003.
   */
  readonly documentDirectory?: string;
}

/** Resolves the same package chain `rs lint` uses without loading project code. */
export function resolveRslint({
  folderRoot,
  mode,
  corePath,
  documentDirectory,
}: ResolveRslintOptions): RslintResolution {
  let rstack: PackageLocation | undefined;
  let shimPath: string | undefined;
  if (mode === 'bridged') {
    rstack = resolveInstalledPackage('rstack', folderRoot, 'missing-rstack');
    shimPath = path.join(rstack.directory, 'dist', 'rslintConfig.js');
    try {
      if (!fs.statSync(shimPath).isFile()) throw new Error('not a file');
    } catch (error) {
      throw new RslintResolutionError(
        'missing-shim',
        `rstack does not provide the lint config shim at ${shimPath}`,
        { cause: error },
      );
    }
  }

  const configuredCorePath = corePath?.trim();
  const core = configuredCorePath
    ? resolveConfiguredCore(folderRoot, configuredCorePath)
    : resolveInstalledPackage(
        '@rslint/core',
        rstack?.directory ?? documentDirectory ?? folderRoot,
        'missing-core',
      );

  return {
    mode,
    coreDir: core.directory,
    coreVersion: core.version,
    ...(rstack === undefined
      ? {}
      : {
          rstackDir: rstack.directory,
          rstackVersion: rstack.version,
          shimPath,
        }),
  };
}
