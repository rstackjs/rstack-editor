/**
 * Classifying and reporting failed Rstest resolutions — the host-side helpers
 * for a `@rstest/core` that cannot be resolved, and the worker-side
 * classifier for a config whose own import failed
 * (`missingDependencyCauseOf`).
 *
 * Every message here replaces Node's own `MODULE_NOT_FOUND` text, which
 * embeds a multi-line require stack and says nothing about what to do. An
 * uninstalled core is the normal state of a freshly cloned repository and is
 * resolved for every config file without the user asking, so it is only
 * logged; a `rstestPackagePath` that does not resolve is a setting the user
 * has to fix, so it is notified.
 */

import path from 'node:path';

/**
 * Resolution failed after the actionable error was already logged or shown.
 * Callers still reject so project initialization stops, but must not report the
 * same failure again.
 */
export class ReportedRstestResolutionError extends Error {
  constructor() {
    super('Failed to resolve rstest path');
    this.name = 'ReportedRstestResolutionError';
  }
}

// Whether `specifier` itself is what could not be found. `MODULE_NOT_FOUND`
// alone is too broad: a package that is installed but whose entry file is gone
// (an interrupted install, or a workspace link that has not been built) throws
// it too, and that must not be reported as "not installed". Node names the
// resolved file in that case and the requested specifier in this one, so the
// message is what separates them. A future Node wording change therefore fails
// towards reporting rather than towards silence.
export function isModuleNotFoundError(
  error: unknown,
  specifier: string,
): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND' &&
    error.message.startsWith(`Cannot find module '${specifier}'`)
  );
}

export function formatConfiguredCoreNotFoundMessage(
  configuredPackagePath: string,
): string {
  return `Cannot find "@rstest/core" at the configured "rstack.rstest.rstestPackagePath": ${configuredPackagePath}. Update the setting to point at an installed "@rstest/core" package.json.`;
}

// The one-line cause when a config evaluation failed on a package that is
// not installed, or `undefined` for a real error. Gated on the error's
// `code` — Node's own classification (`ERR_MODULE_NOT_FOUND` for ESM,
// `MODULE_NOT_FOUND` for CJS) — but the code alone is too broad: a typo'd
// relative import fails with the same codes, and installing dependencies
// cannot fix it, so only a bare specifier — a package name, read from the
// message since CJS carries no structured one — counts, and anything
// unrecognized fails towards the full error report. The check has to run in
// the worker, where the error is thrown: the IPC channel back to the
// extension host (`serialization: 'advanced'`) drops the `code`, so the
// verdict travels as data (`NormalizedConfigResult`). Only the first line
// comes back: the rest of a CJS message is the require stack, and the
// not-installed state is one warn line without one.
export function missingDependencyCauseOf(error: unknown): string | undefined {
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
  return firstLine;
}
