/**
 * Access to the unified extension's public exports channel
 * (`RstackExtensionExports`, see `src/types.ts`). Upstream suites relied on
 * `extension.activate()` resolving only once a language-server root was up;
 * this extension's shell activates without blocking on stack startup
 * (the shell-activation adaptation), so lint-stack lifecycle assertions go through
 * `getStackExports('rslint')` / `whenStackActive('rslint')` instead.
 */
import * as vscode from 'vscode';
import type { RstackExtensionExports } from '../../../src/types';

export const EXTENSION_ID = 'rstack.rstack';

/** Must match the marker `runTest.ts` writes into every sandbox copy. */
export const workspaceMarkerFile = '.rstack-vscode-test-sandbox.json';

export function extensionExports(): RstackExtensionExports {
  const extension =
    vscode.extensions.getExtension<RstackExtensionExports>(EXTENSION_ID);
  if (!extension) {
    throw new Error(`Extension ${EXTENSION_ID} is unavailable`);
  }
  if (!extension.isActive) {
    throw new Error(
      `Extension ${EXTENSION_ID} is not active; runSuite.ts activates it before any test runs`,
    );
  }
  return extension.exports;
}

/** True while the shell has the lint controller registered (gate passed). */
export function isLintStackRegistered(): boolean {
  return extensionExports().getStackExports('rslint') !== undefined;
}

const pollIntervalMs = 100;

/**
 * Bounded poll until the lint stack reaches the requested registration state.
 * Detection flips are watcher-driven and debounced, so a
 * single-shot assertion right after a config mutation would be a coin flip.
 */
export async function waitForLintStackRegistration(
  registered: boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isLintStackRegistered() === registered) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for the Rslint stack to become ${
      registered ? 'registered' : 'unregistered'
    }`,
  );
}
