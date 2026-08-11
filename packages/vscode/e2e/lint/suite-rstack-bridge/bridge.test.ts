/**
 * The lint × Rstack config bridge, end to end.
 *
 * This suite runs against the shared `rstack` fixture — the one workspace in
 * the repo that is a *bridged folder*: `rstack.config.ts` with a `define.lint()`
 * section at the root, no `rslint.config.*` anywhere, and `rstack` +
 * `@rslint/core` installed.
 *
 * Which half of the suite runs is decided at runtime by the project's own
 * `@rslint/core`, resolved exactly the way the extension resolves it:
 *
 * - config-discovery protocol < 2 (every release up to and including 0.7.3):
 *   the language server has no channel to be pinned to a config, so the
 *   capability gate must refuse explicit mode and say so in the status. That
 *   path is asserted today.
 * - protocol >= 2 (rslint PR #1630 onwards): the happy path — diagnostics
 *   produced by a rule that exists only inside `rstack.config.ts`, and a
 *   config-change refresh when that file is edited. Written now, runtime-skipped
 *   until a release carries the protocol bump; nothing else has to change to
 *   unlock it.
 */
import * as assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  BRIDGE_MIN_CONFIG_DISCOVERY_PROTOCOL_VERSION,
  generatedShimPath as productionShimPath,
} from '../../../src/stacks/lint/rstackBridge';
import { loadConfigLoaderModule } from '../../../src/stacks/lint/configLoader';
import { Logger } from '../../../src/stacks/lint/logger';
import { resolveRslint } from '../../../src/stacks/lint/resolution';
import type { StackState } from '../../../src/types';
// Cross-tree, on purpose: `e2e/suite/helpers.ts` owns the polling primitives
// for the whole E2E harness, and both trees compile into `tests-dist/e2e/…`
// under one `rootDir`, so this relative path survives compilation.
import { delay, eventually } from '../../suite/helpers';
import {
  getRslintDiagnostics,
  waitForRslintDiagnostics as waitForDiagnostics,
} from '../utils/diagnostics';
import { extensionExports } from '../utils/extension';

interface RslintStackExports {
  getFolderStates(): ReadonlyMap<string, StackState>;
}

function isRslintStackExports(value: unknown): value is RslintStackExports {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RslintStackExports).getFolderStates === 'function'
  );
}

function workspaceFolder(): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the bridged fixture folder is not open');
  return folder;
}

function folderState(): StackState {
  const exports = extensionExports().getStackExports('rslint');
  assert.ok(exports, 'the lint stack is not registered');
  assert.ok(isRslintStackExports(exports), 'unexpected lint stack exports');
  const folder = workspaceFolder();
  const state = exports.getFolderStates().get(folder.uri.toString());
  // `assert.fail` rather than `assert.ok(state, msg)`: this runs on every poll,
  // and the message must not be built for the passing case.
  if (!state) assert.fail(`no lint state for ${folder.name}`);
  return state;
}

/** Polls a folder-state predicate; every transition here is asynchronous. */
function waitForFolderState(
  predicate: (state: StackState) => boolean,
  description: string,
  timeoutMs = 90_000,
): Promise<StackState> {
  return eventually(
    () => {
      const state = folderState();
      if (!predicate(state)) {
        assert.fail(`last state: ${JSON.stringify(state)}`);
      }
      return state;
    },
    description,
    timeoutMs,
    200,
  );
}

/**
 * The project's config-discovery protocol version, read through the very
 * modules the extension uses — never a version-number guess, and never a
 * duplicate of the resolution rules.
 */
async function resolveProtocolVersion(): Promise<number> {
  const channel = vscode.window.createOutputChannel('rstack-bridge-e2e', {
    log: true,
  });
  try {
    const resolution = await resolveRslint(
      workspaceFolder(),
      new Logger(channel),
    );
    const configLoader = await loadConfigLoaderModule(resolution);
    return configLoader.CONFIG_DISCOVERY_PROTOCOL_VERSION;
  } finally {
    channel.dispose();
  }
}

/**
 * The production path function, not a copy of the literal: the assertion that
 * actually runs today is a *negative* one, so a hand-written path would keep
 * passing after the shim moved — while the extension quietly wrote a file the
 * suite no longer looks at.
 */
const generatedShimPath = (): string =>
  productionShimPath(workspaceFolder().uri.fsPath);

suite('rslint × rstack config bridge', function () {
  this.timeout(180_000);

  let protocolVersion = 0;
  let bridgeSupported = false;

  suiteSetup(async () => {
    protocolVersion = await resolveProtocolVersion();
    bridgeSupported =
      protocolVersion >= BRIDGE_MIN_CONFIG_DISCOVERY_PROTOCOL_VERSION;
    console.log(
      `[bridge] @rslint/core config-discovery protocol ${protocolVersion} (bridge ${bridgeSupported ? 'supported' : 'gated'})`,
    );
  });

  test('the shell lights the lint stack for a bridged folder', () => {
    // No `rslint.config.*` exists anywhere in the fixture: the only reason the
    // stack is registered at all is the root `rstack.config.ts`.
    const configs = fs
      .readdirSync(workspaceFolder().uri.fsPath)
      .filter((entry) => entry.startsWith('rslint.config.'));
    assert.deepEqual(configs, [], 'the fixture must have no native config');
    assert.ok(
      fs.existsSync(
        path.join(workspaceFolder().uri.fsPath, 'rstack.config.ts'),
      ),
      'the fixture must have a root rstack.config.ts',
    );
    // `runSuite.ts` already blocked on `whenStackActive('rslint')`, so reaching
    // this line is the registration assertion; the state map proves the folder
    // itself (not some other root) is what lit it.
    assert.ok(folderState(), 'the bridged folder has no lint state');
  });

  test('the capability gate refuses explicit mode on protocol < 2', async function () {
    if (bridgeSupported) {
      this.skip();
      return;
    }
    const state = await waitForFolderState(
      (candidate) => candidate.kind === 'version-mismatch',
      'the capability gate to surface a version-mismatch status',
    );
    assert.equal(state.kind, 'version-mismatch');
    const detail = state.kind === 'version-mismatch' ? state.detail : '';
    // The message has to name the package to upgrade and the version actually
    // resolved — "unsupported" alone is not actionable.
    assert.match(detail, /upgrade @rslint\/core/);
    assert.match(detail, /protocol/);
    assert.match(detail, /rstack\.config/);

    // No explicit mode means no generated shim: the gate runs before anything
    // is written, so a refused folder leaves no file behind.
    assert.equal(
      fs.existsSync(generatedShimPath()),
      false,
      'a gated folder must not have a generated shim',
    );

    // And no diagnostics, because no language server started for this folder.
    const document = await vscode.workspace.openTextDocument(
      path.join(workspaceFolder().uri.fsPath, 'src', 'index.ts'),
    );
    await delay(3_000);
    assert.deepEqual(
      getRslintDiagnostics(document).map((entry) => entry.message),
      [],
      'a gated folder must not produce diagnostics',
    );
  });

  test('lints from define.lint() with no native config', async function () {
    if (!bridgeSupported) {
      // Unlocked by the first @rslint/core release containing rslint PR #1630
      // (`configPath` on `rslint/configRefresh`).
      //
      // One thing does have to hold when it unlocks: the fixture's config is
      // `rstack.config.ts`, and rstack's loader hardcodes native type stripping
      // with no jiti fallback, so this test also needs a VS Code build whose
      // Node strips types (the rstack-loader preflight surfaces the same
      // condition to users as a status note). Should this fail on that, the
      // answer is a `.mjs` fixture config, not a change to the bridge.
      this.skip();
      return;
    }
    await waitForFolderState(
      (state) => state.kind === 'running',
      'the bridged language server to run',
    );
    assert.ok(
      fs.existsSync(generatedShimPath()),
      'the generated shim must exist in the project',
    );
    const shim = fs.readFileSync(generatedShimPath(), 'utf8');
    assert.match(shim, /rstack\.config\.ts/);

    const document = await vscode.workspace.openTextDocument(
      path.join(workspaceFolder().uri.fsPath, 'src', 'index.ts'),
    );
    await vscode.window.showTextDocument(document);
    const diagnostics = await waitForDiagnostics(document, (entries) =>
      entries.some((entry) => /debugger/i.test(entry.message)),
    );
    // `no-debugger` exists only inside `rstack.config.ts` — the rule firing is
    // the proof that `define.lint()` reached the server unchanged.
    assert.ok(diagnostics.length > 0);
  });

  test('reloads when the rstack config changes', async function () {
    if (!bridgeSupported) {
      this.skip();
      return;
    }
    const configPath = path.join(
      workspaceFolder().uri.fsPath,
      'rstack.config.ts',
    );
    const original = fs.readFileSync(configPath, 'utf8');
    const document = await vscode.workspace.openTextDocument(
      path.join(workspaceFolder().uri.fsPath, 'src', 'index.ts'),
    );
    try {
      // The sandbox is a private copy, so mutating the config here is safe.
      fs.writeFileSync(
        configPath,
        original.replace(`'no-debugger': 'error'`, `'no-debugger': 'off'`),
        'utf8',
      );
      // A `config-change` refresh carrying the same `configPath` — the watch
      // glob of a bridged folder includes `rstack.config.*` for exactly this.
      await waitForDiagnostics(
        document,
        (entries) => !entries.some((entry) => /debugger/i.test(entry.message)),
      );
    } finally {
      fs.writeFileSync(configPath, original, 'utf8');
    }
    await waitForDiagnostics(document, (entries) =>
      entries.some((entry) => /debugger/i.test(entry.message)),
    );
  });
});
