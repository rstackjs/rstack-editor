import assert from 'node:assert/strict';
import type * as vscode from 'vscode';

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until `probe` returns a value instead of throwing.
 *
 * Detection is asynchronous and file-watcher driven, and VS Code's file index
 * is warm only some time after the window opens — a single-shot assertion right
 * after startup would be a coin flip. `probe` throwing is the retry signal, so
 * the failure message of the *last* attempt is what the test reports.
 */
export const eventually = async <T>(
  probe: () => T | Promise<T>,
  what: string,
  timeoutMs = 60_000,
  intervalMs = 250,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      return await probe();
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      assert.fail(
        `Timed out after ${timeoutMs}ms waiting for ${what}: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    }
    await delay(intervalMs);
  }
};

/**
 * Applies the edits a `vscode.executeFormatDocumentProvider` call returned.
 * The command post-processes a provider's edits through VS Code's
 * `computeMoreMinimalEdits`, so they are applied from the end backwards.
 */
export const applyEdits = (
  document: vscode.TextDocument,
  edits: readonly vscode.TextEdit[],
): string => {
  let applied = document.getText();
  for (const edit of [...edits].sort(
    (left, right) =>
      document.offsetAt(right.range.start) -
      document.offsetAt(left.range.start),
  )) {
    const start = document.offsetAt(edit.range.start);
    const end = document.offsetAt(edit.range.end);
    applied = applied.slice(0, start) + edit.newText + applied.slice(end);
  }
  return applied;
};
