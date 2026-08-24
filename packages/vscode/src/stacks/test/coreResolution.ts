/**
 * Helpers for reporting a failed `@rstest/core` resolution.
 *
 * Both messages replace Node's own `MODULE_NOT_FOUND` text, which embeds the
 * require stack of whoever called `require.resolve` — for a bundled extension
 * its `dist` path plus the VS Code extension host — and says nothing about what
 * to do. They differ in where they end up: an uninstalled core is the normal
 * state of a freshly cloned repository and is resolved for every config file
 * without the user asking, so it is only logged; a `rstestPackagePath` that
 * does not resolve is a setting the user has to fix, so it is notified.
 */

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

// Whether a config evaluation failed because something it imports is not
// installed. Read from the error's `code` — Node's own classification, set by
// both loaders (`ERR_MODULE_NOT_FOUND` for ESM, `MODULE_NOT_FOUND` for CJS) —
// never from the message text. Any other failure (a syntax error in the
// config, a thrown plugin) is a real error. The check has to run in the
// worker, where the error is thrown: the IPC channel back to the extension
// host (`serialization: 'advanced'`) keeps an Error's message and stack but
// drops its `code`, so the classification is carried as data instead
// (`NormalizedConfigResult`).
export function isMissingDependencyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code } = error as NodeJS.ErrnoException;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/** `cause` is the loader's own text, which names the specifier and the importer. */
export function formatConfigDependencyMissingMessage(
  configFilePath: string,
  cause: string,
): string {
  return `Cannot load ${configFilePath}: ${cause}. Install the project dependencies to enable Rstest for this config.`;
}
