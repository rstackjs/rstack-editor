import path from 'node:path';

function isMissingDependencyCode(
  code: unknown,
): code is 'ERR_MODULE_NOT_FOUND' | 'MODULE_NOT_FOUND' {
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/**
 * The "config import cannot be resolved" verdict of the not-installed policy
 * (AGENTS.md); in `shared/` because lint/fmt need it too (#30). Returns the
 * loader's first line for a bare specifier — the policy's one warn line, with
 * the CJS require stack dropped — or `undefined` for a real error. A bare
 * specifier failed in the dependency graph, where an install, a lockfile
 * event or the poll can change the answer; a relative, absolute or `file:`
 * specifier failed inside the user's own source, where nothing external will.
 * #52 removed a filesystem walk-up: it could not see a pnpm-isolated private
 * dependency.
 */
export function classifyMissingDependencyMessage(
  message: string,
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
  return firstLine;
}

/** Use for a (code, message) pair; bare messages (fmt) use the classifier directly. */
export function missingDependencyCause(
  code: unknown,
  message: string,
): string | undefined {
  if (!isMissingDependencyCode(code)) return undefined;
  return classifyMissingDependencyMessage(message);
}

/** Use when the caller holds an Error rather than a (code, message) pair. */
export function missingDependencyCauseOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code } = error as NodeJS.ErrnoException;
  return missingDependencyCause(code, error.message);
}
