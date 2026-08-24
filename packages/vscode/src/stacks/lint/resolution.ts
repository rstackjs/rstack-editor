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
  constructor(
    readonly code: RslintResolutionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RslintResolutionError';
  }
}

export interface RslintModeSignals {
  readonly nativeConfigPaths: readonly string[];
  readonly rootRstackConfigPath?: string;
}

/** Native ownership wins; only a root Rstack config can bridge a folder. */
export function decideRslintMode({
  nativeConfigPaths,
  rootRstackConfigPath,
}: RslintModeSignals): RslintMode | undefined {
  if (nativeConfigPaths.length > 0) return 'native';
  if (rootRstackConfigPath !== undefined) return 'bridged';
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
  const directory = path.resolve(folderRoot, configuredPath);
  const packageJsonPath = path.join(directory, 'package.json');
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
