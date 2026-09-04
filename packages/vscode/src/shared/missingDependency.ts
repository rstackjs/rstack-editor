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
 * that is not installed, or `undefined` for a real error. Only a bare
 * specifier — a package name, read from the message since CJS carries no
 * structured one — counts, and anything unrecognized fails towards the full
 * error report. Only the first line comes back: the rest of a CJS message is
 * the require stack, and the not-installed state is one warn line without one.
 */
export function classifyMissingDependencyMessage(
  message: string,
  resolveFrom: string,
): string | undefined {
  const [firstLine] = message.split('\n', 1);
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

/**
 * Error-object entry point used where Node's loader code survives. The code is
 * still required there: arbitrary user errors may contain loader-like prose.
 * Worker/protocol boundaries that already carry a separately checked code use
 * `classifyMissingDependencyMessage` directly because serialization can drop
 * custom Error fields.
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
  return classifyMissingDependencyMessage(error.message, resolveFrom);
}
