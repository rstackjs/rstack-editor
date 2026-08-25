/**
 * Color env handling for the worker spawn, mirroring the CLI's
 * `getForceColorEnv` (rstest `packages/core/src/utils/logger.ts`).
 *
 * The CLI decides which color env vars to inject into its pool processes
 * lazily, at spawn time — after the config has loaded — and injects nothing
 * when `FORCE_COLOR` or `NO_COLOR` is already set, whether by the user's
 * shell or by the config itself (`process.env.NO_COLOR = '1'` in an
 * `rstack.config.ts` is a supported way to turn colors off).
 *
 * The extension has the CLI's problem one level earlier: the worker's stdio
 * is piped, so color detection in the loaded core concludes "no color", yet
 * the output is rendered in VS Code's ANSI-capable test-run terminal. The
 * master therefore plays the terminal's role on the spawn env — injection
 * lands before any worker code (or its imports) can snapshot the env — but
 * only when the user expressed no preference, and the worker retracts the
 * injection at the CLI's own decision point — after config load — if the
 * config turned color off. Without the retraction, pool processes inherit
 * the injected `FORCE_COLOR` alongside the config-set `NO_COLOR`, and Node
 * warns ("The 'NO_COLOR' env is ignored...") in every one of them.
 */

/**
 * Marks an injected `FORCE_COLOR` so the retraction can tell it from a
 * user-set one, which is never touched: that combination warns in the bare
 * CLI too, and silencing it here would hide the user's own conflict.
 */
const INJECTED_MARKER = 'RSTACK_FORCE_COLOR_INJECTED';

/**
 * Force-enable color on the worker's spawn env unless the user already set
 * either standard. Call on the fully composed env (after `nodeEnv` and
 * friends), so a user preference expressed through settings is respected too.
 */
export function injectForceColor(env: NodeJS.ProcessEnv): void {
  if (env.FORCE_COLOR !== undefined || env.NO_COLOR !== undefined) {
    return;
  }
  env.FORCE_COLOR = '1';
  env[INJECTED_MARKER] = '1';
}

/**
 * Retract an earlier injection if the loaded config set `NO_COLOR`. Call in
 * the worker, right after the config has been evaluated.
 */
export function retractForceColorIfDisabled(env: NodeJS.ProcessEnv): void {
  if (env[INJECTED_MARKER] === '1' && env.NO_COLOR !== undefined) {
    delete env.FORCE_COLOR;
    delete env[INJECTED_MARKER];
  }
}
