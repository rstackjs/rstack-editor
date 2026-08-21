// Ported from web-infra-dev/rslint
// `packages/vscode-extension/__tests__/suite-noconfig/noconfig.test.ts`
// (origin/main), with the expectations rewritten for this extension's
// detection rules:
//
// - Upstream treated `rslint.json` as a working fallback config: creating it
//   produced diagnostics, and the suite walked a JSON → JS → JSON lifecycle.
// - This extension does not support `rslint.json` at all. It is not a
//   detection signal, so a folder with only `rslint.json` stays
//   `not detected`, the lint stack is never registered, and zero diagnostics
//   is the *designed* outcome — not a fallback state.
// - `rslint.config.*` remains a live detection signal: creating one must
//   register the stack without a window reload, and deleting the last one
//   must deregister it (the config-glob + lockfile detection watcher).
// - Upstream's "a broken discovered JS config must not fall back to JSON"
//   step is preserved: the Go server owns that behavior and is unchanged.
import * as assert from 'assert';
import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs';
import {
  diagnosticRuleIdIncludes,
  getRslintDiagnostics,
  waitForRslintDiagnostics as waitForDiagnostics,
} from '../utils/diagnostics';
import {
  isLintStackRegistered,
  waitForLintStackRegistration,
} from '../utils/extension';

suite('rslint no config fallback', function () {
  this.timeout(120000);

  function getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders![0].uri.fsPath;
  }

  async function openFixture(filename: string): Promise<vscode.TextDocument> {
    const filePath = path.join(getWorkspaceRoot(), 'src', filename);
    return vscode.workspace.openTextDocument(filePath);
  }

  // Upstream's JSON config, kept verbatim: in this suite it must be inert.
  const jsonConfig = JSON.stringify(
    [
      {
        languageOptions: {
          parserOptions: {
            projectService: false,
            project: ['./tsconfig.json'],
          },
        },
        rules: {
          '@typescript-eslint/no-explicit-any': 'error',
          '@typescript-eslint/no-unsafe-member-access': 'off',
        },
        plugins: ['@typescript-eslint'],
      },
    ],
    null,
    2,
  );

  const jsConfig = `export default [
  {
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.json'],
      },
    },
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
    },
    plugins: ['@typescript-eslint'],
  },
];
`;

  function configPaths(): { json: string; js: string } {
    return {
      json: path.join(getWorkspaceRoot(), 'rslint.json'),
      js: path.join(getWorkspaceRoot(), 'rslint.config.js'),
    };
  }

  async function withConfigFilesAbsent(
    testFn: (paths: { json: string; js: string }) => Promise<void>,
  ): Promise<void> {
    const paths = configPaths();
    const removeConfigs = (): void => {
      fs.rmSync(paths.json, { force: true });
      fs.rmSync(paths.js, { force: true });
      if (fs.existsSync(paths.json) || fs.existsSync(paths.js)) {
        throw new Error('No-config fixture cleanup left a config file behind');
      }
    };

    let testError: unknown;
    try {
      removeConfigs();
      await testFn(paths);
    } catch (error) {
      testError = error;
    }

    let cleanupError: unknown;
    try {
      removeConfigs();
      // Every test must hand the next one the designed ground state: no
      // config, no registered lint stack.
      await waitForLintStackRegistration(false);
    } catch (error) {
      cleanupError = error;
    }
    if (testError && cleanupError) {
      throw new AggregateError(
        [testError, cleanupError],
        'No-config test and config cleanup both failed',
      );
    }
    if (testError) throw testError;
    if (cleanupError) throw cleanupError;
  }

  /** Trigger a no-op edit cycle on the document to force diagnostic refresh. */
  async function triggerDiagnosticRefresh(
    doc: vscode.TextDocument,
  ): Promise<void> {
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((eb) => {
      eb.insert(new vscode.Position(0, 0), ' ');
    });
    await editor.edit((eb) => {
      eb.delete(new vscode.Range(0, 0, 0, 1));
    });
  }

  /**
   * Negative assertions need a bounded observation window: nothing ever fires
   * an event that proves "the stack will not register". Poll the public
   * registration state and the diagnostics collection for the whole window
   * and fail on the first counter-example.
   */
  async function assertStaysUndetected(
    doc: vscode.TextDocument,
    windowMs: number,
    context: string,
  ): Promise<void> {
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      assert.strictEqual(
        isLintStackRegistered(),
        false,
        `${context}: the lint stack must not register`,
      );
      const diagnostics = getRslintDiagnostics(doc);
      assert.strictEqual(
        diagnostics.length,
        0,
        `${context}: expected zero rslint diagnostics, got: ${diagnostics
          .map((d) => d.message)
          .join(' | ')}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  test('a folder without any config is not detected and publishes no diagnostics', async () => {
    await withConfigFilesAbsent(async () => {
      const doc = await openFixture('index.ts');
      await vscode.window.showTextDocument(doc);
      await triggerDiagnosticRefresh(doc);
      // rslint is not zero-config; a folder without a
      // config gets no lint stack and no diagnostics.
      await assertStaysUndetected(doc, 3_000, 'no config at all');
    });
  });

  test('rslint.json alone is not a config and does not light the stack', async () => {
    await withConfigFilesAbsent(async ({ json }) => {
      const doc = await openFixture('index.ts');
      await vscode.window.showTextDocument(doc);

      // Upstream expected this write to produce `no-explicit-any`
      // diagnostics. This extension deliberately drops the deprecated JSON
      // format: it is not a detection signal, so nothing may happen.
      fs.writeFileSync(json, jsonConfig, 'utf8');
      await triggerDiagnosticRefresh(doc);
      await assertStaysUndetected(doc, 5_000, 'rslint.json only');
    });
  });

  test('creating rslint.config.js lights the stack without a reload, deleting it returns to not-detected', async () => {
    await withConfigFilesAbsent(async ({ js }) => {
      const doc = await openFixture('index.ts');
      await vscode.window.showTextDocument(doc);

      // ── Step 1: create the JS config → detection flips, the shell
      // registers the lint stack and the server produces diagnostics.
      fs.writeFileSync(js, jsConfig, 'utf8');
      await waitForLintStackRegistration(true);
      const diags = await waitForDiagnostics(doc, (ds) =>
        ds.some((d) => diagnosticRuleIdIncludes(d, 'no-unsafe-member-access')),
      );
      assert.ok(
        diags.some((d) =>
          diagnosticRuleIdIncludes(d, 'no-unsafe-member-access'),
        ),
        'Step 1: creating rslint.config.js should produce its diagnostics',
      );

      // ── Step 2: delete it → the folder is no longer detected, the stack
      // deregisters and every rslint diagnostic is dropped.
      fs.rmSync(js);
      await waitForLintStackRegistration(false);
      const cleared = await waitForDiagnostics(doc, (ds) => ds.length === 0);
      assert.strictEqual(
        cleared.length,
        0,
        'Step 2: deleting the last config should clear all rslint diagnostics',
      );
    });
  });

  test('a broken JS config does not fall back to rslint.json', async () => {
    // Upstream's lifecycle step 4: a *freshly discovered* broken JS config
    // (no last-good catalog for its path) must yield an explicit no-lint
    // state instead of falling back to JSON. A broken rewrite of an already
    // loaded config would instead keep the last-good catalog active — that
    // scenario belongs to the jsconfig suite ("broken higher-priority config
    // preserves last-good").
    await withConfigFilesAbsent(async ({ json, js }) => {
      const attemptedLoadPath = path.join(
        getWorkspaceRoot(),
        'broken-config-attempted.txt',
      );
      fs.rmSync(attemptedLoadPath, { force: true });
      try {
        const doc = await openFixture('index.ts');
        await vscode.window.showTextDocument(doc);

        // Establish a positive publication first, so the later empty snapshot
        // cannot be the document's not-yet-linted initial state.
        fs.writeFileSync(json, jsonConfig, 'utf8');
        fs.writeFileSync(js, jsConfig, 'utf8');
        await waitForLintStackRegistration(true);
        await waitForDiagnostics(doc, (ds) =>
          ds.some((d) =>
            diagnosticRuleIdIncludes(d, 'no-unsafe-member-access'),
          ),
        );

        // Delete the JS config: the folder is un-detected (rslint.json does
        // not count), the stack deregisters and its last-good
        // catalog dies with the server.
        fs.rmSync(js);
        await waitForLintStackRegistration(false);
        await waitForDiagnostics(doc, (ds) => ds.length === 0);

        // Create a broken JS config fresh. Detection lights the stack again;
        // the new server evaluates the module (observable via the marker),
        // fails, and has no last-good to keep — nor a JSON fallback to take.
        fs.writeFileSync(
          js,
          `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(attemptedLoadPath)}, 'attempted');
throw new Error('intentional broken config');
export default [];
`,
          'utf8',
        );
        await waitForLintStackRegistration(true);
        const markerDeadline = Date.now() + 60_000;
        while (!fs.existsSync(attemptedLoadPath)) {
          if (Date.now() > markerDeadline) {
            throw new Error('The broken JS config was never evaluated');
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // The broken config was provably evaluated; the JSON rule may never
        // surface and no rslint diagnostic may appear at all.
        await triggerDiagnosticRefresh(doc);
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const current = getRslintDiagnostics(doc);
          assert.strictEqual(
            current.length,
            0,
            `A broken discovered JS config must not fall back to rslint.json; got: ${current
              .map((d) => d.message)
              .join(' | ')}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } finally {
        fs.rmSync(attemptedLoadPath, { force: true });
      }
    });
  });
});
