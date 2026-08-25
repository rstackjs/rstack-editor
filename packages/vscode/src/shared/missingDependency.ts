import path from 'node:path';
import { findPackageJsonUncached } from './packageResolve';

/**
 * The classifier behind the "config imports a package that is not installed"
 * verdict of the uniform not-installed policy (AGENTS.md). Nothing in it is
 * Rstest-specific — it reads Node's loader errors — and lint/fmt will need
 * the same verdict where their configs load (#30), which is why it lives in
 * `shared/` beside the walk-up it uses rather than in one stack.
 *
 * Returns the one-line cause when a config evaluation failed on a package
 * that is not installed, or `undefined` for a real error. Gated on the
 * error's `code` — Node's own classification (`ERR_MODULE_NOT_FOUND` for
 * ESM, `MODULE_NOT_FOUND` for CJS) — but the code alone is too broad: a
 * typo'd relative import fails with the same codes, and installing
 * dependencies cannot fix it, so only a bare specifier — a package name,
 * read from the message since CJS carries no structured one — counts, and
 * anything unrecognized fails towards the full error report. The check has
 * to run in the process where the error is thrown: an IPC channel back to
 * the extension host (`serialization: 'advanced'`) drops the `code`, so the
 * verdict travels as data (e.g. `NormalizedConfigResult`). Only the first
 * line comes back: the rest of a CJS message is the require stack, and the
 * not-installed state is one warn line without one.
 */
export function missingDependencyCauseOf(
  error: unknown,
  resolveFrom: string,
): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code } = error as NodeJS.ErrnoException;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
    return undefined;
  }
  const [firstLine] = error.message.split('\n', 1);
  const specifier = /^Cannot find (?:package|module) '([^']+)'/.exec(
    firstLine,
  )?.[1];
  if (
    specifier === undefined ||
    specifier.startsWith('.') ||
    specifier.startsWith('file:') ||
    path.isAbsolute(specifier)
  ) {
    return undefined;
  }
  // `installed-package/missing-subpath` wears the same bare shape, but the
  // package itself is there — installing dependencies cannot fix it either,
  // so a subpath is checked against the physical `node_modules` with the
  // same uncached walk-up every stack resolves packages with.
  const packageName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/', 1)[0];
  if (
    packageName !== specifier &&
    findPackageJsonUncached(packageName, resolveFrom) !== undefined
  ) {
    return undefined;
  }
  return firstLine;
}
