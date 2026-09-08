import { MessageLatch } from './messageLatch';
import {
  COMMAND_CATEGORY,
  STACK_LABELS,
  type StackId,
  stackCommandTitle,
} from '../types';

/**
 * The not-installed policy's words, once for all three stacks (AGENTS.md
 * rules): a project whose dependencies are not installed is a `disabled`
 * status whose reason names the way out, plus one `warn` line in the output
 * channel. The stacks share the wording the way they share
 * `formatVersionMismatch` — each keeps its own status machinery, but what
 * the user reads is one sentence, not three near-copies.
 *
 * A shell-owned poll covers installs that change no lockfile. The trailing
 * restart hint remains the explicit fallback when recovery is delayed or the
 * project stays broken for another reason (ADR 0005).
 */
const restartHint = (stack: StackId): string =>
  `then run "${COMMAND_CATEGORY}: ${stackCommandTitle(stack)}" if this status stays`;

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
 * The output-channel line for a config that imports a package that is not
 * installed. `cause` is the loader's own first line, which names the
 * specifier and the importer.
 */
export const formatConfigDependencyMissingLog = (
  stack: StackId,
  configPath: string,
  cause: string,
): string =>
  `Cannot load ${configPath}: ${cause}. Install the project dependencies to enable ${STACK_LABELS[stack]} for this config.`;

export interface ConfigDependencyFailure {
  readonly configPath: string;
  readonly cause: string;
}

/**
 * Deduplicates one not-installed warning until a successful load ends the
 * episode. Stacks receive their failures over different protocols, but
 * the latch semantics and the user-facing words are the same.
 */
export class NotInstalledEpisode {
  readonly #message = new MessageLatch();

  get active(): boolean {
    return this.#message.current !== undefined;
  }

  observe(stack: StackId, configPath: string, cause: string) {
    const warning = this.#message.changed(`${configPath}\0${cause}`)
      ? formatConfigDependencyMissingLog(stack, configPath, cause)
      : undefined;
    return {
      reason: formatConfigDependencyMissingStatus(stack, configPath),
      warning,
    };
  }

  clear(): boolean {
    const wasActive = this.active;
    this.#message.clear();
    return wasActive;
  }
}

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
