import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  checkPackageVersion,
  formatVersionMismatch,
} from '../../shared/versionCheck';
import { logger } from './logger';
import { nodeRequire } from './nodeRequire';
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
 * where the probe finds nothing and `@rstest/core` would resolve from the wrong
 * root.
 */

/** Relative to the `rstack` package root. Same file `rs test` injects. */
const SHIM_RELATIVE_PATH = path.join('dist', 'rstestConfig.js');

export type RstackShim = {
  /** Absolute path of `<rstack>/dist/rstestConfig.js`. */
  readonly configFilePath: string;
  /** The installed `rstack` version, when it could be read. */
  readonly version?: string;
};

type RstackPackageJson = { version?: string };

/**
 * Resolves the rstack shim for a directory containing an `rstack.config.*`.
 *
 * `rstack`'s exports map has no `./rstestConfig`, no `./config` and no wildcard
 * subpath, so the shim is unreachable by bare specifier
 * (`ERR_PACKAGE_PATH_NOT_EXPORTED`). `./package.json` *is* exported, which makes
 * it the resolution anchor; the shim is then addressed as a filesystem path.
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
  let packageJsonPath: string | undefined;
  try {
    packageJsonPath = nodeRequire.resolve('rstack/package.json', {
      paths: [configDir],
    });
  } catch {
    packageJsonPath = undefined;
  }
  // The shim lives in the project's installed `rstack` package
  // (`node_modules/rstack/dist/...`), so anything resolved from
  // outside a node_modules tree is not it. This also shields against resolvers
  // that self-resolve the enclosing workspace package named "rstack" (this
  // extension's own manifest) despite the explicit `paths` override.
  if (
    packageJsonPath !== undefined &&
    !packageJsonPath.includes(`${path.sep}node_modules${path.sep}`)
  ) {
    packageJsonPath = undefined;
  }
  if (packageJsonPath === undefined) {
    if (!silent) {
      logger.warn(
        `Cannot find the "rstack" package from ${configDir}. Rstest cannot be driven by "rstack.config.*" until the project dependencies are installed.`,
      );
    }
    return undefined;
  }

  const configFilePath = path.join(
    path.dirname(packageJsonPath),
    SHIM_RELATIVE_PATH,
  );
  if (!existsSync(configFilePath)) {
    if (!silent) {
      logger.error(
        `The installed "rstack" package has no ${SHIM_RELATIVE_PATH} (looked in ${packageJsonPath}). Upgrade "rstack" to a version that ships the Rstest config shim.`,
      );
    }
    return undefined;
  }

  let version: string | undefined;
  try {
    version = (nodeRequire(packageJsonPath) as RstackPackageJson).version;
  } catch {
    // A readable `dist/rstestConfig.js` is what the bridge actually needs; an
    // unreadable package.json only costs the version check.
  }

  const result = checkPackageVersion('rstack', version);
  if (result.kind === 'mismatch') {
    const message = formatVersionMismatch('rstack', result);
    if (!silent) {
      logger.error(message);
    }
    status.versionMismatch(message);
    return undefined;
  }

  logger.debug('Resolved the rstack Rstest config shim', {
    configFilePath,
    version,
  });
  status.versionOk();
  return { configFilePath, version };
}
