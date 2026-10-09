// Per-document lint ownership (ADR 0006, issue #85). The folder holds a root
// `rstack.config.ts` (`no-debugger`) and `packages/legacy/rslint.config.ts`
// (`no-empty`); every fixture source violates both rules, so the rule a
// document reports names the config that owns it.
import * as assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { StackState } from '../../../src/types';
import {
  diagnosticRuleIdIncludes,
  waitForRslintDiagnostics,
} from '../utils/diagnostics';
import { extensionExports } from '../utils/extension';

const nativeConfigSource = `export default [
  {
    files: ['**/*.ts'],
    rules: {
      'no-empty': 'error',
    },
  },
];
`;

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('VS Code test workspace is unavailable');
  return folder.uri.fsPath;
}

function getRuntimeStates(): ReadonlyMap<string, StackState> {
  const exports = extensionExports().getStackExports('rslint') as
    { getRuntimeStates?: () => ReadonlyMap<string, StackState> } | undefined;
  assert.ok(exports?.getRuntimeStates, 'lint stack exports are unavailable');
  return exports.getRuntimeStates();
}

/** The bridged runtime's key carries rstack's shim path (`runtimeKey`). */
const isBridgedKey = (key: string): boolean => key.includes('rslintConfig.js');

const hasRule = (diagnostics: readonly vscode.Diagnostic[], rule: string) =>
  diagnostics.some((diagnostic) => diagnosticRuleIdIncludes(diagnostic, rule));

/** Reports `rule` and not `other`: exactly one config owns the document. */
const ownedBy =
  (rule: string, other: string) =>
  (diagnostics: vscode.Diagnostic[]): boolean =>
    hasRule(diagnostics, rule) && !hasRule(diagnostics, other);

const bridged = ownedBy('no-debugger', 'no-empty');
const native = ownedBy('no-empty', 'no-debugger');

async function open(...segments: string[]): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(
    path.join(workspaceRoot(), ...segments, 'src', 'index.ts'),
  );
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

suite('Per-document lint ownership', function () {
  this.timeout(120_000);

  const secondConfigPath = path.join(
    workspaceRoot(),
    'packages',
    'second',
    'rslint.config.ts',
  );

  teardown(() => {
    fs.rmSync(secondConfigPath, { force: true });
  });

  test('lints each document with its nearest config and moves only the documents under a new one', async () => {
    const root = await open();
    const legacy = await open('packages', 'legacy');
    const second = await open('packages', 'second');
    await Promise.all([
      waitForRslintDiagnostics(root, bridged),
      waitForRslintDiagnostics(legacy, native),
      waitForRslintDiagnostics(second, bridged),
    ]);

    // One folder, two runtimes: the bridge and the native config's.
    const keys = [...getRuntimeStates().keys()];
    const bridgedKeys = keys.filter(isBridgedKey);
    assert.equal(
      bridgedKeys.length,
      1,
      `one bridged runtime: ${keys.join(' | ')}`,
    );
    assert.equal(keys.length, 2, `one native runtime: ${keys.join(' | ')}`);
    const [bridgedKey] = bridgedKeys;

    // A restart, even under the same key, passes through `starting` or drops
    // the entry, so sampling the state throughout catches one.
    const violations: string[] = [];
    const sampler = setInterval(() => {
      const state = getRuntimeStates().get(bridgedKey);
      if (state?.kind !== 'running') {
        violations.push(state === undefined ? 'missing' : state.kind);
      }
    }, 25);
    try {
      fs.writeFileSync(secondConfigPath, nativeConfigSource, 'utf8');
      await waitForRslintDiagnostics(second, native);
      await waitForRslintDiagnostics(root, bridged);
      await waitForRslintDiagnostics(legacy, native);
    } finally {
      clearInterval(sampler);
    }
    assert.deepStrictEqual(
      violations,
      [],
      'the bridged runtime serving the root document must not restart',
    );
  });
});
