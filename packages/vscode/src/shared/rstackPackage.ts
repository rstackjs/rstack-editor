import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findPackageJsonUncached, readPackageJson } from './packageResolve';

/**
 * Where an `rstack` installation lives that the walk-up cannot see (#103).
 * Read by fmt and by bridged lint and test; like `corePath`, it changes
 * resolution only, never detection.
 */
export const RSTACK_PACKAGE_PATH_SETTING = 'rstack.rstackCli.packagePath';

/** The `not-installed` log's pointer to the setting, for every rstack caller. */
export const RSTACK_PACKAGE_PATH_HINT = `if it is installed elsewhere, set "${RSTACK_PACKAGE_PATH_SETTING}" to it`;

export type RstackPackageResolution =
  | { readonly kind: 'found'; readonly packageJsonPath: string }
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'invalid-setting'; readonly message: string };

const invalidSetting = (
  configuredPath: string,
  problem: string,
): RstackPackageResolution => ({
  kind: 'invalid-setting',
  message: `The "${RSTACK_PACKAGE_PATH_SETTING}" setting points at ${configuredPath}, which ${problem}. Update the setting to an installed "rstack" package directory or its package.json, or clear it to use the nearest installation.`,
});

/**
 * Locates `rstack/package.json`: the setting's value (`configured`, relative
 * to `folderRoot`) when set, else the walk-up from `folderRoot`. A setting
 * that does not resolve is `invalid-setting`, never the not-installed state.
 * The path is a realpath: under pnpm only the store path has rstack's own
 * dependencies beside it, which lint and test resolve their cores from.
 */
export const resolveRstackPackageJson = (
  folderRoot: string,
  configured?: string,
): RstackPackageResolution => {
  if (configured === undefined) {
    const packageJsonPath = findPackageJsonUncached('rstack', folderRoot);
    return packageJsonPath === undefined
      ? { kind: 'not-installed' }
      : { kind: 'found', packageJsonPath };
  }

  const resolved = path.resolve(folderRoot, configured);
  const configuredPath = configured.endsWith('package.json')
    ? resolved
    : path.join(resolved, 'package.json');
  let packageJsonPath: string;
  try {
    if (!fs.statSync(configuredPath).isFile()) throw new Error('not a file');
    packageJsonPath = fs.realpathSync(configuredPath);
  } catch {
    return invalidSetting(configuredPath, 'does not exist');
  }
  if (readPackageJson(packageJsonPath)?.name !== 'rstack') {
    return invalidSetting(configuredPath, 'is not the "rstack" package');
  }
  return { kind: 'found', packageJsonPath };
};

/**
 * The node args (before the script path) that preload the resolve hook
 * (`rstackResolveHookPreload.mjs`) when the setting chose the rstack at
 * `rstackDirectory`, so the config's own `import 'rstack'` reaches that
 * package. A node arg, not env, so a terminal command line can carry it; the
 * package.json path rides in the URL's `pkg` query.
 */
export const rstackResolveHookArgs = (
  rstackDirectory: string | undefined,
  fromSetting: boolean | undefined,
): string[] => {
  if (rstackDirectory === undefined || !fromSetting) return [];
  // Copied beside the bundles by `rslib.config.mts`.
  const url = pathToFileURL(path.resolve(__dirname, 'rstack-resolve-hook.mjs'));
  url.searchParams.set('pkg', path.join(rstackDirectory, 'package.json'));
  return ['--import', url.href];
};
