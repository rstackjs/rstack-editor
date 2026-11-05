/**
 * COMPAT(rstest<0.13): the only module that knows the pre-0.13 reporter status
 * vocabulary.
 *
 * rstest changed the reporter status literals in the 0.13 line
 * (web-infra-dev/rstest#1875, commit `ffc4eb29`):
 *
 *   TestResultStatus   pass | fail | skip          -> passed | failed | skipped
 *   TestRunStatus      pass | fail                 -> passed | failed
 *
 * `todo` and `error` are unchanged. This extension resolves `@rstest/core`
 * from the user's project (AGENTS.md, resolve-from-project), so projects on
 * either line run against the same bundled code. Every read of a status
 * literal goes through the normalizers below; every call site carries a
 * `COMPAT(rstest<0.13)` tag.
 *
 * The canonical (0.13) shapes are declared here rather than in a separate
 * module on purpose: no consumer imports them — consumers only call the
 * normalizers — so deleting this file changes zero imports.
 *
 * Unknown values normalize to `undefined` instead of falling back to a guess.
 * Each consumer's `default:` branch reports them, so a future vocabulary change
 * surfaces as one logged "unhandled status" instead of a half-working switch.
 *
 * ## Removing this shim (when the pre-0.13 line is dropped)
 *
 * 1. Delete this file and `tests/stacks/test/rstestPre013.test.ts`.
 * 2. Remove every call site tagged `COMPAT(rstest<0.13)`:
 *    `grep -rn "COMPAT(rstest<0.13)" packages/vscode`
 *    In `testRunReporter.ts` the two `switch`es then read `test.status` /
 *    `result.status` directly. In `worker/index.ts` drop `runStatus` and the
 *    `undefined`-warn branch, and compare `result.status` directly against
 *    `'error'` / `'failed'`.
 * 3. Delete the legacy-vocabulary fixtures and the typed-fixture cast tagged
 *    `COMPAT(rstest<0.13)` in `tests/stacks/test/testRunReporter.test.ts` and
 *    `tests/stacks/test/master.test.ts`.
 * 4. Bump the `@rstest/core` devDependency and the E2E fixture pins to the
 *    0.13 line, then raise `SUPPORT_MATRIX['@rstest/core']` in
 *    `src/shared/versionCheck.ts` and its test.
 */

/** The 0.13 (latest) `TestResultStatus`. */
export type TestResultStatus = 'passed' | 'failed' | 'skipped' | 'todo';

/** The 0.13 (latest) `TestRunStatus`. */
export type TestRunStatus = 'passed' | 'failed' | 'error';

type CanonicalStatus = TestResultStatus | TestRunStatus;

/** The one mapping both vocabularies share; the wrappers below narrow it. */
const canonicalStatus = (status: string): CanonicalStatus | undefined => {
  switch (status) {
    case 'passed':
    case 'pass':
      return 'passed';
    case 'failed':
    case 'fail':
      return 'failed';
    case 'skipped':
    case 'skip':
      return 'skipped';
    case 'todo':
      return 'todo';
    case 'error':
      return 'error';
    default:
      return undefined;
  }
};

/**
 * Maps a reported test/suite/file status onto the latest vocabulary.
 * `undefined` means the status is from neither vocabulary.
 */
export const normalizeTestResultStatus = (
  status: string,
): TestResultStatus | undefined => {
  const canonical = canonicalStatus(status);
  return canonical === 'error' ? undefined : canonical;
};

/**
 * Maps a `run()` / `onTestRunEnd` status onto the latest vocabulary.
 * `undefined` means the status is from neither vocabulary.
 */
export const normalizeTestRunStatus = (
  status: string,
): TestRunStatus | undefined => {
  const canonical = canonicalStatus(status);
  return canonical === 'skipped' || canonical === 'todo'
    ? undefined
    : canonical;
};
