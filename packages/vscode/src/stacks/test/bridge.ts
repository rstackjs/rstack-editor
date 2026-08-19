import { existsSync } from 'node:fs';
import path from 'node:path';
import { findPackageJsonUncached } from '../../shared/packageResolve';
import {
  checkPackageVersion,
  formatVersionMismatch,
  readPackageVersion,
} from '../../shared/versionCheck';
import { logger } from './logger';
import { status } from './status';

/**
 * The rstack bridge.
 *
 * A folder governed by `rstack.config.*` (with `define.test()`) and no
 * `rstest.config.*` still has to run tests. `rs test` handles it by injecting
 * `--config <rstack>/dist/rstestConfig.js`
 * (`packages/rstack/src/cli/commands.ts`), a shim that calls
 * `loadRstackConfig()` and — importantly — also performs the automatic
 * `extends` injection (`define.app` → `@rstest/adapter-rsbuild`, else
 * `define.lib` → `@rstest/adapter-rslib`, per inline project). Reimplementing
 * that here would drift, so the bridge hands Rstest the *shipped* shim as an
 * ordinary JS config file, exactly like the CLI does.
 *
 * The layering rule holds: Rstest never learns the name `rstack.config.*`; the
 * bridge lives in this extension.
 *
 * The shim calls `loadRstackConfig()` with no arguments, and that probe is a
 * single `join(cwd, name)` per candidate with **no parent traversal**
 * (`@rstackjs/load-config`). It also runs lazily, inside the worker process, so
 * the worker's spawn cwd is the only anchor it has. That is why the synthesized
 * `Project` must carry an explicit cwd (adaptation #5): pointing a `Project` at
 * the shim without it would cwd the worker into `node_modules/rstack/dist/`,
 * where the probe finds nothing. Package resolution is anchored separately at
 * the resolved `rstack` directory, where package managers such as pnpm install
 * rstack's `@rstest/core` dependency.
 */

/** Relative to the `rstack` package root. Same file `rs test` injects. */
const SHIM_RELATIVE_PATH = path.join('dist', 'rstestConfig.js');

export type RstackShim = {
  /** Absolute path of `<rstack>/dist/rstestConfig.js`. */
  readonly configFilePath: string;
  /** Absolute path of the resolved `rstack` package root. */
  readonly packageDirectory: string;
  /** The installed `rstack` version, when it could be read. */
  readonly version?: string;
};

/**
 * Resolves the rstack shim for a directory containing an `rstack.config.*`.
 *
 * `rstack`'s exports map has no `./rstestConfig`, no `./config` and no wildcard
 * subpath, so the shim is unreachable by bare specifier
 * (`ERR_PACKAGE_PATH_NOT_EXPORTED`). The package.json is the resolution anchor
 * instead — located by an uncached `node_modules` walk-up (`require.resolve`
 * would replay its process-lifetime cache instead of seeing a retargeted
 * install; see `findPackageJsonUncached`) — and the shim is then addressed as
 * a filesystem path. The walk-up only ever yields `node_modules` candidates,
 * which also rules out self-resolving a workspace package named "rstack".
 *
 * Resolution is anchored on the config directory rather than the workspace
 * folder so a monorepo package with its own `rstack` install wins over the root.
 */
export function resolveRstackShim(
  configDir: string,
  // The caller re-resolves on every tree refresh (a fresh `pnpm install` has to
  // be picked up without a reload), so a persistent failure must not re-log.
  { silent = false }: { silent?: boolean } = {},
): RstackShim | undefined {
  const packageJsonPath = findPackageJsonUncached('rstack', configDir);
  if (packageJsonPath === undefined) {
    if (!silent) {
      logger.warn(
        `Cannot find the "rstack" package from ${configDir}. Rstest cannot be driven by "rstack.config.*" until the project dependencies are installed.`,
      );
    }
    return undefined;
  }

  const packageDirectory = path.dirname(packageJsonPath);
  const configFilePath = path.join(packageDirectory, SHIM_RELATIVE_PATH);
  if (!existsSync(configFilePath)) {
    if (!silent) {
      logger.error(
        `The installed "rstack" package has no ${SHIM_RELATIVE_PATH} (looked in ${packageJsonPath}). Upgrade "rstack" to a version that ships the Rstest config shim.`,
      );
    }
    return undefined;
  }

  // An uncached filesystem read: `nodeRequire` would pin the version seen by
  // the first resolution for the lifetime of the extension host, defeating
  // the re-resolution that every `syncBridgeProjects` pass performs.
  const version = readPackageVersion(packageJsonPath);

  const result = checkPackageVersion('rstack', version);
  if (result.kind === 'mismatch') {
    const message = formatVersionMismatch('rstack', result);
    if (!silent) {
      logger.error(message);
    }
    status.versionMismatch(message, configDir);
    return undefined;
  }

  logger.debug('Resolved the rstack Rstest config shim', {
    configFilePath,
    packageDirectory,
    version,
  });
  status.versionOk(configDir);
  return { configFilePath, packageDirectory, version };
}
