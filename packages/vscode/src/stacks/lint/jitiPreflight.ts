import { createRequire } from 'node:module';
import type { WorkspaceFolder } from 'vscode';
import { nativeTypeStrippingAvailable } from '../../shared/vendored/loadRstackConfig';

/**
 * The jiti seam of the version-compatibility contract.
 *
 * `jiti` is an optional peer of `@rslint/core`, used by its
 * `config-file-loader` when native type stripping cannot load a `.ts`/`.mts`
 * config. Under resolve-from-project that loader runs on the **extension
 * host's** Node — whose version is fixed by VS Code, not by the user — so the
 * jiti branch can trigger in the editor even when the CLI works fine.
 *
 * Loader behaviour is deliberately unchanged. Two diagnostics only:
 *
 * 1. `describeJitiPreflight` — preflight that jiti resolves from the project
 *    when a TypeScript config is in play;
 * 2. `isJitiMissingError` — recognise the loader's "Install jiti as a
 *    dependency" failure so it can be surfaced as an actionable hint instead of
 *    a generic config-load failure.
 *
 * Unlike the vendored Rstack loader (which is bundled into the extension and
 * therefore resolves jiti from the *extension*), `@rslint/core`'s
 * config-file-loader is itself loaded from the project, so its `import('jiti')`
 * resolves from the project — which is exactly what this preflight checks.
 */

// `require.resolve` is rewritten by the bundler; `createRequire` is not.
const nodeRequire = createRequire(__filename);

const TYPESCRIPT_CONFIG_RE = /\.[cm]?ts$/;

export const isTypeScriptConfigPath = (configPath: string): boolean =>
  TYPESCRIPT_CONFIG_RE.test(configPath);

/**
 * True when `jiti` resolves from any of the given roots.
 *
 * Two roots matter and they are not the same: the loader's own
 * `await import('jiti')` resolves relative to `@rslint/core`'s install
 * directory (which, under pnpm's strict layout, only sees jiti when the
 * optional peer was actually installed and linked), while the workspace folder
 * is what a user thinks of as "the project". Either hit means the loader has a
 * fair chance of finding jiti, so the preflight only warns when *both* miss —
 * a false negative is much cheaper than a false alarm.
 */
export const jitiResolvesFrom = (roots: readonly string[]): boolean => {
  for (const root of roots) {
    try {
      nodeRequire.resolve('jiti/package.json', { paths: [root] });
      return true;
    } catch {
      // Try the next root.
    }
  }
  return false;
};

export const JITI_INSTALL_HINT =
  'install jiti in the project (`npm install -D jiti`) or move the config to `.js`/`.mjs`';

export interface JitiPreflightInput {
  readonly folder: WorkspaceFolder;
  /** The project's `@rslint/core` directory — the loader's own resolution root. */
  readonly coreDir?: string;
  readonly rslintConfigPaths: readonly string[];
}

/**
 * Returns a status-bar-ready note when a TypeScript Rslint config will need
 * jiti on this host and jiti is not installed in the project. Returns
 * `undefined` when there is nothing to warn about.
 */
export const describeJitiPreflight = ({
  folder,
  coreDir,
  rslintConfigPaths,
}: JitiPreflightInput): string | undefined => {
  const typescriptConfigs = rslintConfigPaths.filter(isTypeScriptConfigPath);
  if (typescriptConfigs.length === 0) {
    return undefined;
  }
  if (nativeTypeStrippingAvailable()) {
    return undefined;
  }
  const roots = coreDir ? [coreDir, folder.uri.fsPath] : [folder.uri.fsPath];
  if (jitiResolvesFrom(roots)) {
    return undefined;
  }
  const subject =
    typescriptConfigs.length === 1
      ? typescriptConfigs[0]
      : `${String(typescriptConfigs.length)} TypeScript Rslint configs`;
  return `this VS Code build cannot strip TypeScript types, so loading ${String(subject)} requires jiti: ${JITI_INSTALL_HINT}`;
};

/**
 * Recognises the multi-line error `@rslint/core`'s `config-file-loader` throws
 * when a TypeScript config cannot be loaded and jiti is absent:
 * `Failed to load TypeScript config file: … 2. Install jiti as a dependency: npm install -D jiti`.
 */
export const isJitiMissingError = (error: unknown): boolean => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof (error as { message?: unknown } | null)?.message === 'string'
          ? String((error as { message: string }).message)
          : '';
  if (!message) {
    return false;
  }
  return (
    /install jiti/i.test(message) ||
    /"?jiti"? package is required/i.test(message) ||
    /cannot find (module|package) ['"]jiti['"]/i.test(message)
  );
};
