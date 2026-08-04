import { describe, expect, it, rs } from '@rstest/core';

// `migration.ts` imports the `vscode` namespace for the write path. The rules
// under test never touch it, but the module still has to load, so the module is
// stubbed away rather than exercised: these tests must run in plain Node, with
// no extension host (unit tests are Rstest, E2E is Electron).
rs.mock('vscode', () => {
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  };
  return { ...vscode, default: vscode };
});

import {
  formatPreview,
  formatValue,
  LEGACY_MAPPINGS,
  type LegacyReading,
  layerLabel,
  planMigration,
} from './migration';

const reading = (partial: Partial<LegacyReading> & { key: string }) =>
  ({
    scopeId: 'user',
    layer: 'user',
    value: 'value',
    ...partial,
  }) satisfies LegacyReading;

const folderReading = (
  scopeId: string,
  folderLabel: string,
  key: string,
  value: unknown,
): LegacyReading => ({
  scopeId,
  layer: 'folder',
  folderLabel,
  key,
  value,
});

describe('LEGACY_MAPPINGS', () => {
  it('covers the full legacy inventory of both retired extensions', () => {
    // 4 settings from rslint/packages/vscode-extension + 14 from
    // rstest/packages/vscode, verified against their manifests.
    expect(LEGACY_MAPPINGS.map((mapping) => mapping.from)).toEqual([
      'rslint.enable',
      'rslint.binPath',
      'rslint.customBinPath',
      'rslint.trace.server',
      'rstest.rstestPackagePath',
      'rstest.nodeExecutable',
      'rstest.nodeExecArgs',
      'rstest.nodeEnv',
      'rstest.debugNodeEnv',
      'rstest.debugExclude',
      'rstest.debugOutFiles',
      'rstest.debuggerPort',
      'rstest.debuggerAddress',
      'rstest.configFileGlobPattern',
      'rstest.testCaseCollectMethod',
      'rstest.applyDiagnostic',
      'rstest.terminalShellPath',
      'rstest.terminalShellArgs',
    ]);
  });

  it('renames every key into the rstack.<stack>.* namespace', () => {
    for (const mapping of LEGACY_MAPPINGS) {
      const [stack, ...rest] = mapping.from.split('.');
      expect(mapping.to).toBe(`rstack.${stack}.${rest.join('.')}`);
    }
  });

  it('has no duplicate source or target keys', () => {
    expect(new Set(LEGACY_MAPPINGS.map((m) => m.from)).size).toBe(
      LEGACY_MAPPINGS.length,
    );
    expect(new Set(LEGACY_MAPPINGS.map((m) => m.to)).size).toBe(
      LEGACY_MAPPINGS.length,
    );
  });

  it('marks the window-scoped Rstest settings as such', () => {
    const windowScoped = LEGACY_MAPPINGS.filter(
      (mapping) => mapping.targetScope === 'window',
    ).map((mapping) => mapping.from);
    expect(windowScoped).toEqual([
      'rstest.configFileGlobPattern',
      'rstest.testCaseCollectMethod',
      'rstest.applyDiagnostic',
      'rstest.terminalShellPath',
      'rstest.terminalShellArgs',
    ]);
  });

  it('only rewrites the value of rslint.binPath', () => {
    const rewriting = LEGACY_MAPPINGS.filter((mapping) => mapping.mapValue);
    expect(rewriting.map((mapping) => mapping.from)).toEqual([
      'rslint.binPath',
    ]);
  });
});

describe('planMigration — mechanical renames', () => {
  it('carries values over untouched', () => {
    const plan = planMigration([
      reading({ key: 'rstest.nodeExecArgs', value: ['--flag'] }),
    ]);
    expect(plan.writeCount).toBe(1);
    expect(plan.scopes[0]?.writes[0]).toMatchObject({
      from: 'rstest.nodeExecArgs',
      to: 'rstack.rstest.nodeExecArgs',
      value: ['--flag'],
      rewritten: false,
    });
  });

  it('preserves falsy values that are explicitly set', () => {
    const plan = planMigration([
      reading({ key: 'rslint.enable', value: false }),
      reading({ key: 'rstest.debuggerPort', value: 0 }),
      reading({ key: 'rstest.terminalShellPath', value: '' }),
    ]);
    expect(plan.writeCount).toBe(3);
    expect(plan.scopes[0]?.writes.map((write) => write.value)).toEqual([
      false,
      0,
      '',
    ]);
  });

  it('ignores keys that are not part of the inventory', () => {
    const plan = planMigration([
      reading({ key: 'rslint.somethingElse' }),
      reading({ key: 'editor.defaultFormatter' }),
    ]);
    expect(plan.writeCount).toBe(0);
    expect(plan.skips).toEqual([]);
  });

  it('ignores readings whose value is undefined', () => {
    // `inspect()` reports `undefined` for a layer that does not set the key;
    // migrating it would materialise the default into the settings file.
    const plan = planMigration([
      reading({ key: 'rstest.applyDiagnostic', value: undefined }),
    ]);
    expect(plan.writeCount).toBe(0);
  });
});

describe('planMigration — rslint.binPath', () => {
  it('maps an explicit built-in to local', () => {
    const plan = planMigration([
      reading({ key: 'rslint.binPath', value: 'built-in' }),
    ]);
    expect(plan.scopes[0]?.writes[0]).toMatchObject({
      to: 'rstack.rslint.binPath',
      fromValue: 'built-in',
      value: 'local',
      rewritten: true,
    });
  });

  it('carries local and custom over unchanged', () => {
    for (const value of ['local', 'custom']) {
      const plan = planMigration([reading({ key: 'rslint.binPath', value })]);
      expect(plan.scopes[0]?.writes[0]).toMatchObject({
        value,
        rewritten: false,
      });
    }
  });

  it('carries the custom path over next to the mode', () => {
    const plan = planMigration([
      reading({ key: 'rslint.binPath', value: 'custom' }),
      reading({ key: 'rslint.customBinPath', value: '/opt/rslint' }),
    ]);
    expect(
      plan.scopes[0]?.writes.map((write) => [write.to, write.value]),
    ).toEqual([
      ['rstack.rslint.binPath', 'custom'],
      ['rstack.rslint.customBinPath', '/opt/rslint'],
    ]);
  });

  it('never invents a value when the setting was not set', () => {
    // The dropped `built-in` default must not leak in as an explicit `local`.
    expect(planMigration([]).writeCount).toBe(0);
  });

  it('skips values that are not in the new enum', () => {
    for (const value of ['auto', '', 42, null]) {
      const plan = planMigration([reading({ key: 'rslint.binPath', value })]);
      expect(plan.writeCount).toBe(0);
      expect(plan.skips[0]).toMatchObject({
        from: 'rslint.binPath',
        reason: 'unsupported-value',
      });
    }
  });
});

describe('planMigration — layers', () => {
  it('groups writes per layer and orders them user, workspace, folder', () => {
    const plan = planMigration([
      folderReading('file:///w/app', 'app', 'rslint.enable', false),
      reading({
        scopeId: 'workspace',
        layer: 'workspace',
        key: 'rstest.nodeExecArgs',
        value: [],
      }),
      reading({ key: 'rslint.enable', value: true }),
    ]);
    expect(plan.scopes.map((scope) => scope.label)).toEqual([
      'User Settings',
      'Workspace Settings',
      'Folder Settings — app',
    ]);
    expect(plan.writeCount).toBe(3);
  });

  it('keeps same-named folders of a multi-root workspace apart', () => {
    const plan = planMigration([
      folderReading('file:///a/app', 'app', 'rslint.enable', true),
      folderReading('file:///b/app', 'app', 'rslint.enable', false),
    ]);
    expect(plan.scopes.map((scope) => scope.scopeId)).toEqual([
      'file:///a/app',
      'file:///b/app',
    ]);
    expect(plan.scopes.map((scope) => scope.writes[0]?.value)).toEqual([
      true,
      false,
    ]);
  });

  it('reports whether files inside the repository would be touched', () => {
    expect(
      planMigration([reading({ key: 'rslint.enable', value: true })])
        .touchesRepositoryFiles,
    ).toBe(false);
    expect(
      planMigration([
        reading({
          scopeId: 'workspace',
          layer: 'workspace',
          key: 'rslint.enable',
          value: true,
        }),
      ]).touchesRepositoryFiles,
    ).toBe(true);
  });

  it('orders the writes of one layer by the inventory, not by input order', () => {
    const plan = planMigration([
      reading({ key: 'rstest.applyDiagnostic', value: false }),
      reading({ key: 'rslint.enable', value: true }),
    ]);
    expect(plan.scopes[0]?.writes.map((write) => write.from)).toEqual([
      'rslint.enable',
      'rstest.applyDiagnostic',
    ]);
  });

  it('skips a window-scoped setting at the folder layer only', () => {
    const folder = planMigration([
      folderReading('file:///w', 'w', 'rstest.applyDiagnostic', false),
    ]);
    expect(folder.writeCount).toBe(0);
    expect(folder.skips[0]).toMatchObject({ reason: 'not-folder-scoped' });

    const workspace = planMigration([
      reading({
        scopeId: 'workspace',
        layer: 'workspace',
        key: 'rstest.applyDiagnostic',
        value: false,
      }),
    ]);
    expect(workspace.writeCount).toBe(1);
  });

  it('keeps a resource-scoped setting at the folder layer', () => {
    const plan = planMigration([
      folderReading('file:///w', 'w', 'rstest.nodeExecutable', '/usr/bin/node'),
    ]);
    expect(plan.writeCount).toBe(1);
  });
});

describe('planMigration — conflicts', () => {
  it('never overwrites a new key the user already set in the same layer', () => {
    const plan = planMigration([
      reading({
        key: 'rslint.binPath',
        value: 'built-in',
        targetValue: 'custom',
      }),
    ]);
    expect(plan.writeCount).toBe(0);
    expect(plan.skips[0]).toMatchObject({
      from: 'rslint.binPath',
      to: 'rstack.rslint.binPath',
      reason: 'target-already-set',
    });
  });

  it('treats a conflict as layer-local', () => {
    const plan = planMigration([
      reading({ key: 'rslint.enable', value: true, targetValue: false }),
      reading({
        scopeId: 'workspace',
        layer: 'workspace',
        key: 'rslint.enable',
        value: true,
      }),
    ]);
    expect(plan.writeCount).toBe(1);
    expect(plan.scopes[0]?.layer).toBe('workspace');
    expect(plan.skips).toHaveLength(1);
  });
});

describe('formatValue', () => {
  it('renders values on a single line', () => {
    expect(formatValue('local')).toBe('"local"');
    expect(formatValue(['a', 'b'])).toBe('["a","b"]');
    expect(formatValue(undefined)).toBe('undefined');
  });

  it('truncates long values', () => {
    const formatted = formatValue('x'.repeat(200));
    expect(formatted.length).toBe(60);
    expect(formatted.endsWith('…')).toBe(true);
  });
});

describe('formatPreview', () => {
  it('shows the old -> new mapping under its layer heading', () => {
    const preview = formatPreview(
      planMigration([
        reading({ key: 'rslint.binPath', value: 'built-in' }),
        folderReading('file:///w/app', 'app', 'rslint.enable', false),
      ]),
    );
    expect(preview).toContain('User Settings');
    expect(preview).toContain('rslint.binPath -> rstack.rslint.binPath');
    expect(preview).toContain('"built-in" -> "local"');
    expect(preview).toContain('Folder Settings — app');
    expect(preview).toContain('rslint.enable -> rstack.rslint.enable');
  });

  it('lists what was left untouched and why', () => {
    const preview = formatPreview(
      planMigration([
        reading({ key: 'rslint.binPath', value: 'auto' }),
        folderReading('file:///w/app', 'app', 'rstest.applyDiagnostic', false),
      ]),
    );
    expect(preview).toContain('Left untouched');
    expect(preview).toContain('is not a valid value of rstack.rslint.binPath');
    expect(preview).toContain('window-scoped setting');
  });

  it('is empty when there is nothing to report', () => {
    expect(formatPreview(planMigration([]))).toBe('');
  });
});

describe('layerLabel', () => {
  it('names every layer', () => {
    expect(layerLabel('user')).toBe('User Settings');
    expect(layerLabel('workspace')).toBe('Workspace Settings');
    expect(layerLabel('folder', 'pkg')).toBe('Folder Settings — pkg');
  });
});
