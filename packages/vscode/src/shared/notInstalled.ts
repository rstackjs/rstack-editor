import { COMMAND_CATEGORY, type StackId, stackCommandTitle } from '../types';

/**
 * The not-installed policy's words, once for all three stacks (AGENTS.md
 * rules): a project whose dependencies are not installed is a `disabled`
 * status whose reason names the way out, plus one `warn` line in the output
 * channel. The stacks share the wording the way they share
 * `formatVersionMismatch` — each keeps its own status machinery, but what
 * the user reads is one sentence, not three near-copies.
 *
 * The trailing hint covers the recovery no watcher sees: an install that
 * changes no lockfile (a fresh clone whose lockfile is already current) fires
 * no detection pass, so the restart command is the way out and the status is
 * where it has to be named (ADR 0002).
 */
const restartHint = (stack: StackId): string =>
  `then run "${COMMAND_CATEGORY}: ${stackCommandTitle(stack, 'restart')}" if this status stays`;

/** The `disabled` reason for a package the stack needs and cannot find. */
export const formatNotInstalledStatus = (
  stack: StackId,
  packageName: string,
): string =>
  `${packageName} is not installed (node_modules missing) — install it, ${restartHint(stack)}`;

/**
 * The `disabled` reason for a config that evaluates but imports a package
 * that is not there. `configPath` is workspace-relative: the status has no
 * room for more.
 */
export const formatConfigDependencyMissingStatus = (
  stack: StackId,
  configPath: string,
): string =>
  `${configPath} imports a package that is not installed — install the project dependencies, ${restartHint(stack)}`;

/**
 * The output-channel line: where the stack looked, plus the stack's own
 * consequence — the same shape as the shared Node preflight message
 * (adaptation 6), where each caller appends what the state means for it.
 */
export const formatNotInstalledLog = (
  packageName: string,
  folderName: string,
  searchedFrom: string,
  consequence?: string,
): string =>
  `${packageName} is not installed in ${folderName} (node_modules missing); searched from ${searchedFrom}${
    consequence ? `; ${consequence}` : ''
  }`;
