import vscode from 'vscode';

/**
 * Settings migration from retired names into current ones: the two standalone
 * extensions (`rstack.rslint` and `rstack.rstest`) into the unified `rstack.*`
 * namespace.
 *
 * Shape of the feature:
 *
 * - legacy keys are discovered with `workspace.getConfiguration().inspect()`,
 *   which reports the *explicitly set* value per layer and never the default —
 *   defaults must not be materialised into the user's settings files;
 * - three layers are handled: User, Workspace and WorkspaceFolder, and each one
 *   is written back separately, against its own `ConfigurationTarget`;
 * - Workspace and Folder writes touch files inside the user's repository, so
 *   nothing is written before a preview (old key -> new key, per layer) has been
 *   confirmed;
 * - detection of legacy keys raises exactly one dismissible prompt; the command
 *   itself is always available from the Command Palette.
 *
 * Command ids are deliberately *not* migrated: VS Code exposes no keybindings
 * API, so keybindings bound to `rslint.*` / `rstest.*` command ids break
 * silently. That cost is deliberately accepted and is restated in the
 * confirmation dialog.
 *
 * Everything above `collectLegacyReadings` is pure and free of the `vscode`
 * namespace object, so the mapping rules can be unit tested without an
 * extension host (`migration.test.ts`).
 */

// ---------------------------------------------------------------------------
// Pure layer: the mapping table and the planner
// ---------------------------------------------------------------------------

/** The configuration layers `inspect()` reports and `update()` can target. */
export type MigrationLayer = 'user' | 'workspace' | 'folder';

/**
 * Why a legacy key that *is* set was not carried over. Reported in the preview
 * so a skipped key is never silently dropped.
 */
export type SkipReason =
  /** The legacy value has no equivalent in the new setting's schema. */
  | 'unsupported-value'
  /** The new key already has an explicit value in the same layer. */
  | 'target-already-set'
  /** A folder-layer value for a window-scoped target setting. */
  | 'not-folder-scoped'
  /** The legacy setting represented a feature that no longer exists. */
  | 'no-equivalent-setting';

type ValueMapping =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'skip'; readonly reason: SkipReason };

export interface LegacyMapping {
  /** Fully qualified legacy key, e.g. `rslint.enable`. */
  readonly from: string;
  /** Fully qualified new key, e.g. `rstack.rslint.enable`. */
  readonly to: string;
  /**
   * Scope of the *new* key in this extension's manifest. A window-scoped
   * setting cannot be written to `ConfigurationTarget.WorkspaceFolder`, so a
   * folder-layer legacy value for one of those is skipped instead of throwing
   * at write time.
   */
  readonly targetScope: 'resource' | 'window';
  /**
   * Value rewrite. Absent for the mechanical renames, which carry the value
   * over untouched.
   */
  readonly mapValue?: (value: unknown) => ValueMapping;
}

/**
 * Legacy Rstest keys, in manifest order. Every one of them is a mechanical
 * `rstest.<key>` -> `rstack.rstest.<key>` rename; only the scope of the *new*
 * key differs, and it is the new manifest that decides it. The one exception,
 * `rstest.nodeExecutable`, is mapped explicitly below: its target is the
 * shared `rstack.nodeExecutable`, not a `rstack.rstest.*` key.
 *
 * Derived from `rstest/packages/vscode/package.json` (14 settings) and this
 * repository's `contributes.configuration`. Rstest contributes no `enable`
 * setting upstream, so `rstack.rstest.enable` has no legacy source.
 */
const RSTEST_KEYS: readonly (readonly [string, 'resource' | 'window'])[] = [
  ['rstestPackagePath', 'resource'],
  ['nodeExecArgs', 'resource'],
  ['nodeEnv', 'resource'],
  ['debugNodeEnv', 'resource'],
  ['debugExclude', 'resource'],
  ['debugOutFiles', 'resource'],
  ['debuggerPort', 'resource'],
  ['debuggerAddress', 'resource'],
  ['configFileGlobPattern', 'window'],
  ['testCaseCollectMethod', 'window'],
  ['applyDiagnostic', 'window'],
  ['terminalShellPath', 'window'],
  ['terminalShellArgs', 'window'],
];

/**
 * The migratable legacy inventory: 3 Rslint keys + 14 Rstest keys. Kept in one
 * table so the preview, writer and tests cannot disagree.
 */
export const LEGACY_MAPPINGS: readonly LegacyMapping[] = [
  {
    from: 'rslint.enable',
    // The manifest declares `rstack.rslint.enable` as window-scoped (the
    // shell reads it without a resource URI), so a folder-level legacy value
    // cannot be preserved and must be skipped as `not-folder-scoped`.
    to: 'rstack.rslint.enable',
    targetScope: 'window',
  },
  {
    from: 'rslint.corePath',
    to: 'rstack.rslint.corePath',
    targetScope: 'resource',
  },
  {
    from: 'rslint.trace.server',
    to: 'rstack.rslint.trace.server',
    targetScope: 'resource',
  },
  {
    // The runtime pin became a shared setting when the fmt LSP server joined
    // the test worker on the User Node runtime, so the standalone extension's
    // key maps to `rstack.nodeExecutable`, not to a `rstack.rstest.*` one.
    from: 'rstest.nodeExecutable',
    to: 'rstack.nodeExecutable',
    targetScope: 'resource',
  },
  ...RSTEST_KEYS.map(([key, targetScope]) => ({
    from: `rstest.${key}`,
    to: `rstack.rstest.${key}`,
    targetScope,
  })),
];

/**
 * These retired binary-only settings cannot name the core package directory
 * required by the lint worker. Detect them for the preview, but never rewrite
 * or remove them.
 */
const DROPPED_LEGACY_KEYS = ['rslint.binPath', 'rslint.customBinPath'] as const;

const LEGACY_SOURCE_KEYS: readonly string[] = [
  ...LEGACY_MAPPINGS.map((mapping) => mapping.from),
  ...DROPPED_LEGACY_KEYS,
];

const DROPPED_LEGACY_KEY_SET: ReadonlySet<string> = new Set(
  DROPPED_LEGACY_KEYS,
);

const MAPPINGS_BY_KEY = new Map(
  LEGACY_MAPPINGS.map((mapping) => [mapping.from, mapping]),
);

/** One explicitly-set legacy value found in one layer. */
export interface LegacyReading {
  /**
   * Opaque, stable identifier of the configuration scope the value was read
   * from. The pure layer only groups by it; the `vscode` layer maps it back to
   * a workspace folder. Folder names are *not* unique in a multi-root
   * workspace, which is why the label is carried separately.
   */
  readonly scopeId: string;
  readonly layer: MigrationLayer;
  /** Display name of the workspace folder; only set for the `folder` layer. */
  readonly folderLabel?: string;
  readonly key: string;
  readonly value: unknown;
  /**
   * Explicit value of the *new* key in the same layer, if the user already set
   * it. Migrating on top of it would silently overwrite a deliberate choice.
   */
  readonly targetValue?: unknown;
}

export interface PlannedWrite {
  readonly scopeId: string;
  readonly layer: MigrationLayer;
  readonly folderLabel?: string;
  readonly from: string;
  readonly to: string;
  readonly fromValue: unknown;
  readonly value: unknown;
  /** True when the mapping changed the value (`built-in` -> `local`). */
  readonly rewritten: boolean;
}

export interface PlannedSkip {
  readonly scopeId: string;
  readonly layer: MigrationLayer;
  readonly folderLabel?: string;
  readonly from: string;
  readonly to?: string;
  readonly value: unknown;
  readonly reason: SkipReason;
}

/** All writes that go to one `ConfigurationTarget` in one scope. */
export interface PlannedScope {
  readonly scopeId: string;
  readonly layer: MigrationLayer;
  readonly folderLabel?: string;
  readonly label: string;
  readonly writes: readonly PlannedWrite[];
}

export interface MigrationPlan {
  /** Non-empty scopes, ordered User -> Workspace -> Folders. */
  readonly scopes: readonly PlannedScope[];
  readonly skips: readonly PlannedSkip[];
  readonly writeCount: number;
  /** True when at least one write lands in a file inside the user's repo. */
  readonly touchesRepositoryFiles: boolean;
}

export const layerLabel = (
  layer: MigrationLayer,
  folderLabel?: string,
): string => {
  switch (layer) {
    case 'user':
      return 'User Settings';
    case 'workspace':
      return 'Workspace Settings';
    case 'folder':
      return `Folder Settings — ${folderLabel ?? '?'}`;
  }
};

const LAYER_ORDER: Readonly<Record<MigrationLayer, number>> = {
  user: 0,
  workspace: 1,
  folder: 2,
};

/**
 * Turns raw readings into the exact set of writes to perform, grouped by the
 * scope they are written to. Pure: same readings in, same plan out.
 *
 * Readings for unknown keys and readings whose value is `undefined` (i.e. not
 * explicitly set in that layer) are ignored.
 */
export const planMigration = (
  readings: readonly LegacyReading[],
): MigrationPlan => {
  const scopes: PlannedScope[] = [];
  const writesByScope = new Map<string, PlannedWrite[]>();
  const skips: PlannedSkip[] = [];

  const scopeFor = (reading: LegacyReading): PlannedWrite[] => {
    const existing = writesByScope.get(reading.scopeId);
    if (existing) {
      return existing;
    }
    const writes: PlannedWrite[] = [];
    writesByScope.set(reading.scopeId, writes);
    scopes.push({
      scopeId: reading.scopeId,
      layer: reading.layer,
      folderLabel: reading.folderLabel,
      label: layerLabel(reading.layer, reading.folderLabel),
      writes,
    });
    return writes;
  };

  const order = new Map(LEGACY_SOURCE_KEYS.map((key, index) => [key, index]));
  const sorted = [...readings].sort((a, b) => {
    const byLayer = LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer];
    if (byLayer !== 0) {
      return byLayer;
    }
    return (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0);
  });

  for (const reading of sorted) {
    if (reading.value === undefined) {
      continue;
    }
    if (DROPPED_LEGACY_KEY_SET.has(reading.key)) {
      skips.push({
        scopeId: reading.scopeId,
        layer: reading.layer,
        folderLabel: reading.folderLabel,
        from: reading.key,
        value: reading.value,
        reason: 'no-equivalent-setting',
      });
      continue;
    }
    const mapping = MAPPINGS_BY_KEY.get(reading.key);
    if (!mapping) continue;

    const skip = (reason: SkipReason): void => {
      skips.push({
        scopeId: reading.scopeId,
        layer: reading.layer,
        folderLabel: reading.folderLabel,
        from: mapping.from,
        to: mapping.to,
        value: reading.value,
        reason,
      });
    };

    if (reading.targetValue !== undefined) {
      skip('target-already-set');
      continue;
    }
    if (reading.layer === 'folder' && mapping.targetScope === 'window') {
      skip('not-folder-scoped');
      continue;
    }

    const mapped: ValueMapping = mapping.mapValue
      ? mapping.mapValue(reading.value)
      : { kind: 'value', value: reading.value };
    if (mapped.kind === 'skip') {
      skip(mapped.reason);
      continue;
    }

    const writes = scopeFor(reading);
    writes.push({
      scopeId: reading.scopeId,
      layer: reading.layer,
      folderLabel: reading.folderLabel,
      from: mapping.from,
      to: mapping.to,
      fromValue: reading.value,
      value: mapped.value,
      rewritten: mapped.value !== reading.value,
    });
  }

  const nonEmpty = scopes.filter((scope) => scope.writes.length > 0);
  return {
    scopes: nonEmpty,
    skips,
    writeCount: nonEmpty.reduce(
      (total, scope) => total + scope.writes.length,
      0,
    ),
    touchesRepositoryFiles: nonEmpty.some((scope) => scope.layer !== 'user'),
  };
};

const MAX_VALUE_LENGTH = 60;

/** Compact, single-line rendering of a settings value for the preview. */
export const formatValue = (value: unknown): string => {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > MAX_VALUE_LENGTH
    ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…`
    : text;
};

const SKIP_EXPLANATIONS: Readonly<
  Record<SkipReason, (skip: PlannedSkip) => string>
> = {
  'unsupported-value': (skip) =>
    `${formatValue(skip.value)} is not a valid value of ${skip.to ?? 'the replacement setting'}`,
  'target-already-set': (skip) =>
    `${skip.to ?? 'the replacement setting'} is already set here`,
  'not-folder-scoped': (skip) =>
    `${skip.to} is a window-scoped setting and cannot be set per folder`,
  'no-equivalent-setting': () =>
    'this binary-only setting has no equivalent; configure rstack.rslint.corePath with an @rslint/core package directory if an override is still needed',
};

/**
 * The old -> new preview shown before anything is written. Plain text: it is
 * rendered in a modal dialog's `detail`, which does not interpret markdown.
 */
export const formatPreview = (plan: MigrationPlan): string => {
  const blocks: string[] = [];

  for (const scope of plan.scopes) {
    const lines = scope.writes.map((write) => {
      const rewrite = write.rewritten
        ? `   (${formatValue(write.fromValue)} -> ${formatValue(write.value)})`
        : '';
      return `  ${write.from} -> ${write.to}${rewrite}`;
    });
    blocks.push([scope.label, ...lines].join('\n'));
  }

  if (plan.skips.length > 0) {
    const lines = plan.skips.map((skip) => {
      const where = layerLabel(skip.layer, skip.folderLabel);
      return `  ${skip.from} (${where}): ${SKIP_EXPLANATIONS[skip.reason](skip)}`;
    });
    blocks.push(['Left untouched', ...lines].join('\n'));
  }

  return blocks.join('\n\n');
};

// ---------------------------------------------------------------------------
// vscode layer: reading, confirming, writing
// ---------------------------------------------------------------------------

const USER_SCOPE = 'user';
const WORKSPACE_SCOPE = 'workspace';

const targetOf = (layer: MigrationLayer): vscode.ConfigurationTarget => {
  switch (layer) {
    case 'user':
      return vscode.ConfigurationTarget.Global;
    case 'workspace':
      return vscode.ConfigurationTarget.Workspace;
    case 'folder':
      return vscode.ConfigurationTarget.WorkspaceFolder;
  }
};

/**
 * Reads every legacy key in every layer. `inspect()` is the only API that
 * separates "explicitly set in this layer" from "inherited or defaulted", which
 * is exactly the distinction the migration is built on.
 */
export const collectLegacyReadings = (): {
  readonly readings: readonly LegacyReading[];
  readonly folders: ReadonlyMap<string, vscode.WorkspaceFolder>;
} => {
  const readings: LegacyReading[] = [];
  const folders = new Map<string, vscode.WorkspaceFolder>();
  // A Folder layer distinct from the Workspace layer only exists once a
  // `.code-workspace` file is in play (which is also what multi-root implies —
  // adding a second folder creates an untitled workspace file). With a single
  // folder opened directly, `.vscode/settings.json` *is* the Workspace layer and
  // `inspect()` reports its values as both `workspaceValue` and
  // `workspaceFolderValue`; scanning the folder layer there would plan every
  // reading twice and, for the window-scoped Rstest keys, report a bogus
  // "cannot be set per folder" skip next to the write that actually happens.
  const hasFolderLayer = vscode.workspace.workspaceFile !== undefined;
  const workspaceFolders = hasFolderLayer
    ? (vscode.workspace.workspaceFolders ?? [])
    : [];
  for (const folder of workspaceFolders) {
    folders.set(folder.uri.toString(), folder);
  }

  for (const key of LEGACY_SOURCE_KEYS) {
    const mapping = MAPPINGS_BY_KEY.get(key);
    const legacy = vscode.workspace.getConfiguration().inspect<unknown>(key);
    const target = mapping
      ? vscode.workspace.getConfiguration().inspect<unknown>(mapping.to)
      : undefined;

    if (legacy?.globalValue !== undefined) {
      readings.push({
        scopeId: USER_SCOPE,
        layer: 'user',
        key,
        value: legacy.globalValue,
        targetValue: target?.globalValue,
      });
    }
    if (legacy?.workspaceValue !== undefined) {
      readings.push({
        scopeId: WORKSPACE_SCOPE,
        layer: 'workspace',
        key,
        value: legacy.workspaceValue,
        targetValue: target?.workspaceValue,
      });
    }

    for (const folder of workspaceFolders) {
      const scoped = vscode.workspace.getConfiguration(undefined, folder.uri);
      const value = scoped.inspect<unknown>(key)?.workspaceFolderValue;
      if (value === undefined) {
        continue;
      }
      readings.push({
        scopeId: folder.uri.toString(),
        layer: 'folder',
        folderLabel: folder.name,
        key,
        value,
        targetValue: mapping
          ? scoped.inspect<unknown>(mapping.to)?.workspaceFolderValue
          : undefined,
      });
    }
  }

  return { readings, folders };
};

/** Convenience wrapper: is there anything at all to migrate? */
export const hasLegacySettings = (): boolean =>
  planMigration(collectLegacyReadings().readings).writeCount > 0;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const KEYBINDING_NOTE =
  'Command ids were renamed to rstack.* with no aliases: keybindings bound to the old rslint.* / rstest.* commands are not migrated and have to be re-bound manually.';

interface WriteOutcome {
  readonly migrated: number;
  readonly failed: number;
}

/**
 * Writes one scope. The legacy key is removed only after its replacement has
 * been written, so a failure can never lose the value.
 */
const writeScope = async (
  scope: PlannedScope,
  folder: vscode.WorkspaceFolder | undefined,
  output: vscode.LogOutputChannel,
): Promise<WriteOutcome> => {
  const configuration = vscode.workspace.getConfiguration(
    undefined,
    folder?.uri,
  );
  const target = targetOf(scope.layer);
  let migrated = 0;
  let failed = 0;

  for (const write of scope.writes) {
    try {
      await configuration.update(write.to, write.value, target);
    } catch (error) {
      failed += 1;
      output.error(
        `[${scope.label}] failed to write ${write.to}: ${errorMessage(error)}`,
      );
      continue;
    }
    migrated += 1;
    output.info(
      `[${scope.label}] ${write.from} -> ${write.to} = ${formatValue(write.value)}`,
    );
    try {
      await configuration.update(write.from, undefined, target);
    } catch (error) {
      // The value is already carried over; a leftover legacy key is cosmetic.
      output.warn(
        `[${scope.label}] migrated ${write.from} but could not remove it: ${errorMessage(error)}`,
      );
    }
  }

  return { migrated, failed };
};

export interface MigrationRunOptions {
  /** Skip the "nothing to migrate" notification (used by the prompt path). */
  readonly silentWhenEmpty?: boolean;
}

/**
 * The `rstack.migrateSettings` command. Always available from the Command
 * Palette; safe to run repeatedly (a second run finds nothing left to do).
 *
 * Returns `true` when at least one setting was written.
 */
export const runSettingsMigration = async (
  output: vscode.LogOutputChannel,
  { silentWhenEmpty = false }: MigrationRunOptions = {},
): Promise<boolean> => {
  const { readings, folders } = collectLegacyReadings();
  const plan = planMigration(readings);

  if (plan.writeCount === 0) {
    const detail = plan.skips.length > 0 ? `\n${formatPreview(plan)}` : '';
    output.info(`No legacy settings to migrate.${detail}`);
    if (!silentWhenEmpty) {
      void vscode.window.showInformationMessage(
        plan.skips.length > 0
          ? 'Rstack: nothing left to migrate. See the Rstack output channel for the settings that were left untouched.'
          : 'Rstack: no settings under legacy names were found.',
      );
    }
    return false;
  }

  const preview = formatPreview(plan);
  output.info(`Settings migration preview:\n${preview}`);

  // Workspace and Folder writes land in files inside the user's
  // repository, so the preview must be confirmed first. The User layer is
  // confirmed along with them — one dialog is both simpler and more honest
  // than silently rewriting half of the plan.
  const scopeNote = plan.touchesRepositoryFiles
    ? 'Workspace and folder settings files in this repository will be modified.'
    : 'Only your user settings will be modified.';
  const confirmed = await vscode.window.showInformationMessage(
    `Migrate ${plan.writeCount} setting${plan.writeCount === 1 ? '' : 's'} to the rstack.* namespace?`,
    {
      modal: true,
      detail: `${preview}\n\n${scopeNote} The legacy keys are removed once their replacement has been written.\n\n${KEYBINDING_NOTE}`,
    },
    'Migrate',
  );
  if (confirmed !== 'Migrate') {
    output.info('Settings migration cancelled by the user.');
    return false;
  }

  let migrated = 0;
  let failed = 0;
  // Each layer is written back separately, against its own target.
  for (const scope of plan.scopes) {
    const folder =
      scope.layer === 'folder' ? folders.get(scope.scopeId) : undefined;
    if (scope.layer === 'folder' && !folder) {
      // The folder disappeared between the preview and the confirmation.
      output.warn(`[${scope.label}] workspace folder is gone, skipped.`);
      continue;
    }
    const outcome = await writeScope(scope, folder, output);
    migrated += outcome.migrated;
    failed += outcome.failed;
  }

  const summary =
    failed > 0
      ? `Rstack: migrated ${migrated} setting(s), ${failed} failed — see the Rstack output channel.`
      : `Rstack: migrated ${migrated} setting(s). ${KEYBINDING_NOTE}`;
  void vscode.window.showInformationMessage(summary);
  output.info(
    `Settings migration finished: ${migrated} written, ${failed} failed.`,
  );
  return migrated > 0;
};

export const PROMPT_DISMISSED_KEY = 'rstack.migration.dismissed';

/**
 * The single dismissible prompt. Shown at most once per user
 * once "Don't ask again" is chosen; "Not now" leaves it for the next window,
 * and the command stays available from the palette either way.
 */
export const maybePromptForMigration = async (
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
): Promise<void> => {
  if (context.globalState.get<boolean>(PROMPT_DISMISSED_KEY) === true) {
    return;
  }

  const plan = planMigration(collectLegacyReadings().readings);
  if (plan.writeCount === 0) {
    return;
  }
  output.info(`Found ${plan.writeCount} setting(s) under legacy names.`);

  const migrate = 'Migrate…';
  const dismiss = "Don't ask again";
  const choice = await vscode.window.showInformationMessage(
    'Rstack found settings under legacy names (from the standalone Rslint/Rstest extensions). Migrate them to their current names?',
    migrate,
    'Not now',
    dismiss,
  );
  if (choice === migrate) {
    await runSettingsMigration(output, { silentWhenEmpty: true });
  } else if (choice === dismiss) {
    await context.globalState.update(PROMPT_DISMISSED_KEY, true);
  }
};
