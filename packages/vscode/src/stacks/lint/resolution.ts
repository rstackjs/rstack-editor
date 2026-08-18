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
    throw new RslintResolutionError(
      'missing-core',
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
}

/** Resolves the same package chain `rs lint` uses without loading project code. */
export function resolveRslint({
  folderRoot,
  mode,
  corePath,
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
        rstack?.directory ?? folderRoot,
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
