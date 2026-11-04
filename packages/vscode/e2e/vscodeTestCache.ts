/**
 * `VSCODE_TEST_CACHE_PATH` moves the VS Code download out of `.vscode-test/`.
 * rstack-ecosystem-ci runs `git clean -fdxq` in the checkout before each
 * suite, which would wipe an in-checkout cache between jobs. Unset keeps
 * `@vscode/test-electron`'s default.
 *
 * Shared by every E2E entry point so a new runner cannot silently fall back to
 * the in-checkout cache.
 */
export const vscodeTestCachePath =
  process.env.VSCODE_TEST_CACHE_PATH || undefined;
