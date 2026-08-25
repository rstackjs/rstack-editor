/**
 * Classifying and reporting failed Rstest resolutions — the host-side helpers
 * for a `@rstest/core` that cannot be resolved. (The worker-side classifier
 * for a config whose own import failed is `shared/missingDependency.ts`.)
 *
 * Every message here replaces Node's own `MODULE_NOT_FOUND` text, which
 * embeds a multi-line require stack and says nothing about what to do. An
 * uninstalled core is the normal state of a freshly cloned repository and is
 * resolved for every config file without the user asking, so it is only
 * logged; a `rstestPackagePath` that does not resolve is a setting the user
 * has to fix, so it is notified.
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
