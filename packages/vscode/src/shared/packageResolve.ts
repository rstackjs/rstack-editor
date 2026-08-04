import fs from 'node:fs';
import path from 'node:path';

/**
 * Locates `<packageName>/package.json` by walking `node_modules` up from
 * `fromDir`, with plain fs calls and a final `fs.realpathSync`.
 *
 * `require.resolve` is unusable for a *re*-resolution: Node caches every
 * successful lookup for the process lifetime (`Module._pathCache` keyed by
 * request + paths, plus the CJS loader's realpath cache for symlink targets),
 * so once a package resolved, later calls replay the pre-upgrade answer after
 * pnpm retargets the `node_modules` symlink. Failed lookups are not cached —
 * which is why resolve-after-install always worked; this helper closes the
 * upgrade/downgrade half. `fs.realpathSync` uses no persistent cache, so the
 * returned path always reflects the current link target (and is the
 * version-pinned store path on pnpm).
 *
 * Only the walk-up half of Node's algorithm is implemented: a `package.json`
 * lookup needs no exports-map logic. Callers that need entry points resolve
 * them anchored at the returned path, which keys Node's cache by a
 * version-pinned location.
 */
export const findPackageJsonUncached = (
  packageName: string,
  fromDir: string,
): string | undefined => {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(
      dir,
      'node_modules',
      ...packageName.split('/'),
      'package.json',
    );
    try {
      if (fs.statSync(candidate).isFile()) {
        return fs.realpathSync(candidate);
      }
    } catch {
      // Keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
};

/**
 * Reads and parses a package.json with a plain filesystem read — never
 * `require`, whose module cache would pin the first-seen contents until the
 * extension host reloads. Returns `undefined` when unreadable.
 */
export const readPackageJson = (
  packageJsonPath: string,
): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
};
