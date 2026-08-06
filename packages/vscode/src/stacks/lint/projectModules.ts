import { pathToFileURL } from 'node:url';

/**
 * Loads an ESM module from an absolute path resolved out of the *user's*
 * project (the resolve-from-project adaptation).
 *
 * Two constraints shape this helper:
 *
 * - The extension bundle is CJS while `@rslint/core` is ESM (`"type":
 *   "module"`), so the module has to be reached through a dynamic `import()`,
 *   never `require`.
 * - The specifier is a fully dynamic expression, which Rspack emits verbatim
 *   instead of turning into a bundled chunk (verified against the repo's own
 *   rslib output), so the load really happens at runtime against the project's
 *   file. A bare specifier would resolve from the extension instead, which is
 *   exactly the bundling seam the resolve-from-project adaptation deletes.
 * - Windows: only `file:`/`data:`/`node:` URLs are accepted by Node's default
 *   ESM loader, so absolute paths are converted with `pathToFileURL`.
 *
 * There is deliberately no invalidation hook, and a restart does not get one.
 * The memo below is the *second* cache in front of these modules: Node's own
 * ESM registry is keyed by resolved URL and lives as long as the extension
 * host, so once a path has loaded, re-importing it returns the identical
 * module object no matter what this map says. Adding a cache-busting query to
 * the specifier does reload the entry module, but a relative specifier inside
 * it does not inherit the query — the result is a fresh entry wired to its own
 * stale dependencies, which is worse than being consistently stale. A
 * `node_modules` replaced in place under an unchanged path therefore needs a
 * window reload; see the README's note on what restart does and does not
 * recover.
 */
const cache = new Map<string, Promise<unknown>>();

export const importProjectModule = async <T>(
  absolutePath: string,
): Promise<T> => {
  let pending = cache.get(absolutePath) as Promise<T> | undefined;
  if (!pending) {
    const specifier = pathToFileURL(absolutePath).href;
    pending = (import(specifier) as Promise<T>).catch((error: unknown) => {
      // Never cache a rejected load: a transient failure (a half-installed
      // node_modules, a mid-reinstall window) must stay retryable.
      cache.delete(absolutePath);
      throw error;
    });
    cache.set(absolutePath, pending as Promise<unknown>);
  }
  return pending;
};
