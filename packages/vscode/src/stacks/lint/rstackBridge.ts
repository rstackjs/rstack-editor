import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  findPackageJsonUncached,
  readPackageJson,
} from '../../shared/packageResolve';
// The sibling preflight owns the "is this config TypeScript" predicate; both
// seams answer the same question about the same host, so they share one
// definition rather than two regexes that can drift. `jitiPreflight` imports
// `vscode` for types only, so this stays a `vscode`-free module graph.
import { isTypeScriptConfigPath } from './jitiPreflight';

/**
 * The lint × Rstack config bridge.
 *
 * A **bridged folder** is a workspace folder where
 *
 * 1. no native `rslint.config.{js,mjs,ts,mts}` exists *anywhere* in the folder,
 *    and
 * 2. an `rstack.config.{ts,js,mts,mjs}` sits at the folder **root**.
 *
 * Only then does lint light up through the Rstack config. Ownership is decided
 * per folder, not per directory: any native Rslint config anywhere in the
 * folder means pure native mode and the bridge yields entirely — no hint, no
 * warning. That granularity is forced by the LSP, not chosen: the
 * explicit-config choice is fixed for the whole server process lifetime, there
 * is one language server per workspace folder, and the server's cwd is the
 * folder root. A `rstack.config.*` in a **subdirectory** therefore does not
 * light lint at all; the folder root is the only position the bridge can
 * honour.
 *
 * The bridge never re-implements Rstack config semantics. It writes a
 * **generated shim** — a tiny ESM module inside the project — that calls the
 * project's *own* `rstack` package through its published `./config` export and
 * re-exports `configs.lint`, mirroring `rs lint`'s injected
 * `<rstack>/dist/rslintConfig.js` exactly. rstack's shipped shim cannot be used
 * directly: it calls `loadRstackConfig()` with no arguments, which probes the
 * **evaluation** cwd — and config evaluation happens in the extension host,
 * whose cwd is meaningless. The generated shim bakes the absolute config path
 * in instead.
 *
 * Everything here is a pure function over strings plus two filesystem
 * primitives, so the whole decision table is unit-testable without a `vscode`
 * stub.
 */

/**
 * The Rstack config file names in `loadRstackConfig`'s own probe order
 * (`rstack.config.ts`, `.js`, `.mts`, `.mjs` — verified against
 * `RSTACK_CONFIG_FILE_NAMES` in `shared/vendored/loadRstackConfig.ts`, the
 * vendored copy of that loader).
 *
 * The order carries meaning: it decides which file the generated shim points at
 * when a folder root somehow holds more than one, so the answer is stable
 * instead of filesystem-order dependent.
 *
 * This is also the single owner of the name list for the whole extension —
 * `detection.ts` re-exports it as `RSTACK_CONFIG_NAMES` for the watch table.
 * This module is the one that can own it: it pulls in no `vscode`.
 */
export const RSTACK_CONFIG_PROBE_ORDER = [
  'rstack.config.ts',
  'rstack.config.js',
  'rstack.config.mts',
  'rstack.config.mjs',
] as const;

/**
 * Where the generated shim goes: inside the project, so module and plugin
 * resolution from the shim anchors on the project rather than on the
 * extension.
 *
 * A bridged folder normally already has a `node_modules` — `rstack` has to be
 * installed for the bridge to work at all — but that is a tendency, not an
 * invariant: `rstack` is resolved by a `node_modules` walk-*up*, so a package
 * inside a hoisting monorepo can be bridged with its own `node_modules`
 * absent. The directory is then created, deliberately: the alternative is
 * writing the shim to a path the project's own resolver cannot see through,
 * and `node_modules/.cache/` is the conventional home for exactly this kind of
 * tool-generated file.
 */
const GENERATED_SHIM_RELATIVE_DIR = path.join(
  'node_modules',
  '.cache',
  'rstack-editor',
);

/**
 * `.mjs`, and named like a config on purpose: the language server accepts a
 * JS/TS config path, and an ESM extension keeps the shim independent of the
 * project's `package.json` `type` field.
 *
 * Living under `node_modules` is what keeps the name safe. Detection excludes
 * every `node_modules` path outright, so the generated shim can never be
 * mistaken for a native config — which would flip Ownership to native and
 * restart the folder into the mode that deletes the shim's reason to exist. The
 * config-refresh watcher normally never sees the shim either — VS Code's
 * default `files.watcherExclude` swallows `node_modules` events — but that is
 * a user setting, so the no-churn write rule below is what actually guarantees
 * a shim write cannot feed a refresh loop (and it keeps the intact case a pure
 * read on every refresh).
 */
const GENERATED_SHIM_BASENAME = 'rslint.config.mjs';

/**
 * The config-discovery protocol version that first carries the optional
 * `configPath` field on `rslint/configRefresh` (rslint PR #1630). Bridged mode
 * is gated on the *capability*, read from the project's own
 * `@rslint/core/config-loader` constant, rather than on a release number —
 * the release containing the PR is not known here, and guessing one would
 * either strand users or start a mode the server cannot honour.
 */
export const BRIDGE_MIN_CONFIG_DISCOVERY_PROTOCOL_VERSION = 2;

/** A bridged folder whose prerequisites could not be met. */
export class RstackBridgeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RstackBridgeError';
  }
}

/**
 * A bridged folder the extension refuses to start, because the project's own
 * packages cannot support explicit mode. Distinct from `RstackBridgeError` (and
 * from a crash) so it can be reported as `version mismatch` — the state whose
 * whole meaning is "the project's packages need attention", and whose detail is
 * the instruction.
 *
 * The distinction matters most where detection is the *only* reason the stack
 * exists: a bridged folder was lit by an `rstack.config.*`, so its user never
 * asked for Rslint by name and must not be shown a crash.
 *
 * The gates raising it differ only in their message — one class, because that
 * is the whole granularity anything consumes (`Rslint`'s start-failure
 * classification and the coordinator's expected-failure predicate both test
 * exactly this type):
 *
 * 1. the **capability** gate — the project's `@rslint/core` speaks a
 *    config-discovery protocol with no `configPath`, so there is no channel to
 *    pin a config to (`formatBridgeProtocolGate`);
 * 2. the **toolchain** gate — the folder is bridge-eligible but `@rslint/core`
 *    does not resolve from it at all (`formatBridgeToolchainGap`). That is the
 *    *common* shape, not an edge case: `@rslint/core` is a transitive
 *    dependency of `rstack`, and an isolated `node_modules` layout (pnpm by
 *    default) deliberately does not expose transitive dependencies, so the
 *    mainstream bridged project — an rstack-cli app whose only config is
 *    `rstack.config.ts` — cannot resolve it. Native mode's identical failure
 *    stays a crash: there the user wrote an `rslint.config.*`, an explicit
 *    request for a tool that is missing;
 * 3. the **rstack-loader** gates — `rstack` itself does not resolve from the
 *    folder, or resolves but predates the `./config` export (`< 0.4.0`). Both
 *    describe a package-version prerequisite whose remedy is an install or an
 *    upgrade, exactly what `version mismatch` means. A *present* `./config`
 *    entry in a shape this extension cannot take stays `RstackBridgeError`:
 *    the install is not old, so "upgrade" would mislead.
 */
export class RstackBridgeGateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RstackBridgeGateError';
  }
}

export const formatBridgeToolchainGap = (
  rstackConfigPath: string,
  detail: string,
): string =>
  `linting from ${path.basename(
    rstackConfigPath,
  )} needs @rslint/core installed in the project: ${detail} rstack depends on @rslint/core only transitively, and package managers with an isolated node_modules layout (pnpm) do not expose transitive dependencies — add @rslint/core to the project's devDependencies, or add an rslint.config.* file`;

export type LintConfigMode =
  /** Automatic server-side discovery — byte-identical to upstream. */
  | { readonly kind: 'native' }
  | { readonly kind: 'bridged'; readonly rstackConfigPath: string };

export interface LintConfigModeInput {
  /** Absolute path of the workspace folder root. */
  readonly folderPath: string;
  /** Every native `rslint.config.*` found anywhere in the folder. */
  readonly rslintConfigPaths: readonly string[];
  /** Every `rstack.config.*` found anywhere in the folder. */
  readonly rstackConfigPaths: readonly string[];
}

/**
 * The folder-root Rstack config, in `loadRstackConfig`'s probe order.
 * `undefined` when every candidate sits in a subdirectory — or carries a name
 * outside the probe order, which the loader would not find either.
 */
export const folderRootRstackConfigPath = (
  folderPath: string,
  rstackConfigPaths: readonly string[],
): string | undefined => {
  const root = path.resolve(folderPath);
  const atRoot = rstackConfigPaths.filter(
    (candidate) => path.resolve(path.dirname(candidate)) === root,
  );
  for (const name of RSTACK_CONFIG_PROBE_ORDER) {
    const match = atRoot.find((candidate) => path.basename(candidate) === name);
    if (match) return match;
  }
  return undefined;
};

/**
 * The Ownership decision for one workspace folder. Native wins whenever a
 * native config exists anywhere; a folder with neither signal stays `native`,
 * which for the client means "send no `configPath`" — exactly today's
 * behaviour.
 */
export const decideLintConfigMode = (
  input: LintConfigModeInput,
): LintConfigMode => {
  if (input.rslintConfigPaths.length > 0) {
    return { kind: 'native' };
  }
  const rstackConfigPath = folderRootRstackConfigPath(
    input.folderPath,
    input.rstackConfigPaths,
  );
  return rstackConfigPath === undefined
    ? { kind: 'native' }
    : { kind: 'bridged', rstackConfigPath };
};

/**
 * Whether detection must light the lint stack for this folder: a native config
 * anywhere, or a bridged folder. One rule, one place — the shell's detection
 * and the stack's mode selection are the same decision seen twice.
 */
export const lintIsDetected = (input: LintConfigModeInput): boolean =>
  input.rslintConfigPaths.length > 0 ||
  decideLintConfigMode(input).kind === 'bridged';

/**
 * A stable identity for the mode a folder is in. A change means the live
 * language server is pinned the wrong way and has to be restarted — the choice
 * is immutable for a server process.
 */
export const lintConfigModeSignature = (mode: LintConfigMode): string =>
  mode.kind === 'bridged' ? `bridged:${mode.rstackConfigPath}` : 'native';

export const supportsExplicitConfigPath = (protocolVersion: number): boolean =>
  protocolVersion >= BRIDGE_MIN_CONFIG_DISCOVERY_PROTOCOL_VERSION;

export const formatBridgeProtocolGate = (
  protocolVersion: number,
  coreVersion: string | undefined,
): string =>
  `linting from rstack.config.* needs a newer @rslint/core: the project's @rslint/core ${
    coreVersion ?? 'of unknown version'
  } speaks config-discovery protocol ${String(protocolVersion)}, and pinning the language server to a config needs protocol ${String(
    BRIDGE_MIN_CONFIG_DISCOVERY_PROTOCOL_VERSION,
  )} or newer — upgrade @rslint/core, or add an rslint.config.* file`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The export conditions an ESM `import` of the generated shim matches, most
 * specific first. `require` is deliberately absent: the shim is `.mjs` and
 * imports the target by `file:` URL, so taking a `require` branch would pin it
 * to a CommonJS build the moment `rstack` splits the entry.
 */
const IMPORT_EXPORT_CONDITIONS = [
  'import',
  'node',
  'module',
  'default',
] as const;

/**
 * The target an ESM importer would take out of one `exports` entry: a string
 * is the target, an object is a condition map (recursed into, conditions in
 * the order above), an array is a fallback list (first entry that yields one).
 *
 * Not `createRequire(...).resolve('rstack/config')`: Node's require-resolution
 * matches the `require` conditions, while the generated shim is ESM.
 */
const pickImportTarget = (entry: unknown): string | undefined => {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) {
    for (const candidate of entry) {
      const target = pickImportTarget(candidate);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  if (!isRecord(entry)) return undefined;
  for (const condition of IMPORT_EXPORT_CONDITIONS) {
    const target = pickImportTarget(entry[condition]);
    if (target !== undefined) return target;
  }
  return undefined;
};

/** The raw `./config` entry of `rstack`'s `exports` map, if it declares one. */
const readConfigExportEntry = (
  packageJson: Record<string, unknown>,
): unknown => {
  const exportsField = packageJson.exports;
  return isRecord(exportsField) ? exportsField['./config'] : undefined;
};

/**
 * Resolves the project's own `rstack/config` entry (`dist/configExports.js`)
 * to an absolute path.
 *
 * The `package.json` is located by an uncached `node_modules` walk-up, not by
 * `require.resolve`: a fresh install has to be picked up without a window
 * reload, and Node caches successful resolutions for the process lifetime. The
 * entry itself is then read out of the package's own `exports` map, so a
 * future layout change in `rstack` follows automatically.
 */
export const resolveRstackConfigLoader = (folderPath: string): string => {
  const packageJsonPath = findPackageJsonUncached('rstack', folderPath);
  if (packageJsonPath === undefined) {
    throw new RstackBridgeGateError(
      `Could not resolve the "rstack" package from ${folderPath}. Linting from rstack.config.* needs the project's own rstack install — run the project's package manager.`,
    );
  }
  const packageJson = readPackageJson(packageJsonPath);
  // An unreadable manifest is a broken install, not a package prerequisite —
  // "upgrade rstack" would mislead, so it is not a gate.
  if (packageJson === undefined) {
    throw new RstackBridgeError(
      `Could not read the installed "rstack" manifest at ${packageJsonPath}. The install looks broken — run the project's package manager, or add an rslint.config.* file.`,
    );
  }
  const entry = readConfigExportEntry(packageJson);
  if (entry === undefined) {
    throw new RstackBridgeGateError(
      `The installed "rstack" (${packageJsonPath}) does not export "./config". Upgrade rstack to a version that publishes the config loader (>= 0.4.0), or add an rslint.config.* file.`,
    );
  }
  // An entry that exists but yields nothing is a shape this extension does not
  // understand, not an outdated install — saying "upgrade" would send the user
  // somewhere that cannot help.
  const target = pickImportTarget(entry);
  if (target === undefined) {
    throw new RstackBridgeError(
      `The installed "rstack" (${packageJsonPath}) exports "./config" as ${JSON.stringify(
        entry,
      )}, which has no target an ESM import can take. Add an rslint.config.* file, or report this against the Rstack extension.`,
    );
  }
  const loaderPath = path.resolve(path.dirname(packageJsonPath), target);
  if (!fs.existsSync(loaderPath)) {
    throw new RstackBridgeError(
      `The installed "rstack" exports "./config" as ${target}, which is missing at ${loaderPath}.`,
    );
  }
  return loaderPath;
};

export interface GeneratedShimInput {
  /** Absolute path of the project's `rstack/config` entry. */
  readonly configLoaderPath: string;
  /** Absolute path of the folder-root `rstack.config.*`. */
  readonly rstackConfigPath: string;
}

/**
 * Renders the generated shim.
 *
 * The body mirrors rstack's shipped `dist/rslintConfig.js`: take
 * `configs.lint ?? []`, await it when it is a function, default-export the
 * result. `define.lint`'s value *is* an Rslint flat config — there is no
 * translation step and there must never be one.
 *
 * Both baked-in paths are absolute and both go through an escaping step, so a
 * Windows path (`C:\Users\…`) survives verbatim: the loader is embedded as a
 * `file:` URL (forward slashes, percent-encoded) and the config path as a JSON
 * string literal (backslashes escaped).
 */
export const renderGeneratedShim = ({
  configLoaderPath,
  rstackConfigPath,
}: GeneratedShimInput): string =>
  `// Generated by the Rstack VS Code extension — do not edit, do not commit.
//
// This folder is linted from an Rstack config: no rslint.config.* exists and
// ${path.basename(rstackConfigPath)} sits at the folder root. The language
// server is pinned to this file, which is the editor-side equivalent of the
// shim \`rs lint\` injects, with the config path baked in — config evaluation
// happens in the VS Code extension host, whose cwd cannot be probed for it.
import { loadRstackConfig } from ${JSON.stringify(pathToFileURL(configLoaderPath).href)};

const { configs } = await loadRstackConfig({
  configFilePath: ${JSON.stringify(rstackConfigPath)},
});
const lintExports = configs.lint ?? [];
export default typeof lintExports === 'function'
  ? await lintExports()
  : lintExports;
`;

export interface WriteGeneratedShimInput extends GeneratedShimInput {
  /** Absolute path of the workspace folder root. */
  readonly folderPath: string;
}

export interface GeneratedShim {
  /** Absolute path of the shim — what the client sends as `configPath`. */
  readonly path: string;
  /** False when the file was already byte-identical. */
  readonly written: boolean;
}

export const generatedShimPath = (folderPath: string): string =>
  path.join(folderPath, GENERATED_SHIM_RELATIVE_DIR, GENERATED_SHIM_BASENAME);

/**
 * Writes the generated shim, but only when its content actually differs.
 *
 * The no-churn rule is not tidiness: the shim lives under a path the config
 * watcher can observe, and every rewrite is a config mutation the language
 * server would have to reload.
 */
export const writeGeneratedShim = ({
  folderPath,
  configLoaderPath,
  rstackConfigPath,
}: WriteGeneratedShimInput): GeneratedShim => {
  const shimPath = generatedShimPath(folderPath);
  const source = renderGeneratedShim({ configLoaderPath, rstackConfigPath });
  let current: string | undefined;
  try {
    current = fs.readFileSync(shimPath, 'utf8');
  } catch {
    // Absent or unreadable: write it.
  }
  if (current === source) {
    return { path: shimPath, written: false };
  }
  try {
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(shimPath, source, 'utf8');
  } catch (error) {
    throw new RstackBridgeError(
      `Could not write the generated Rslint config shim to ${shimPath}.`,
      { cause: error },
    );
  }
  return { path: shimPath, written: true };
};

/**
 * Deletes a generated shim left behind by an earlier bridged lifecycle, and
 * reports whether there was one.
 *
 * A folder flips to native mode the moment an `rslint.config.*` appears, and
 * the artifact must not outlive the mode that justified it: it is a file
 * literally named `rslint.config.mjs` sitting in the project, naming a config
 * path that is no longer the governing one. Detection cannot be confused by it
 * (`node_modules` is excluded outright), which is why this is hygiene rather
 * than correctness — but hygiene the extension owes for a file it wrote.
 */
export const removeGeneratedShim = (folderPath: string): boolean => {
  const shimPath = generatedShimPath(folderPath);
  try {
    fs.rmSync(shimPath);
    return true;
  } catch {
    // Absent (the overwhelmingly common case) or not ours to delete.
    return false;
  }
};

export interface RstackConfigLoaderPreflightInput {
  readonly rstackConfigPath: string;
  /** `nativeTypeStrippingAvailable()` on the extension host. */
  readonly nativeTypeStripping: boolean;
}

/**
 * The rstack-loader seam of the version-compatibility contract, the sibling of
 * the jiti preflight.
 *
 * `loadRstackConfig` hardcodes `loader: 'native'` and has **no** jiti
 * fallback, so a TypeScript Rstack config cannot be loaded at all on a VS Code
 * build whose Node cannot strip types. The CLI never hits this (it runs on the
 * user's own Node); the editor can. Diagnostics only — the loader behaviour is
 * deliberately left alone.
 */
export const describeRstackConfigLoaderPreflight = ({
  rstackConfigPath,
  nativeTypeStripping,
}: RstackConfigLoaderPreflightInput): string | undefined => {
  if (nativeTypeStripping) return undefined;
  if (!isTypeScriptConfigPath(rstackConfigPath)) return undefined;
  return `this VS Code build cannot strip TypeScript types, and rstack's config loader has no fallback, so ${path.basename(
    rstackConfigPath,
  )} may fail to load: rename it to rstack.config.js/.mjs, or add an rslint.config.* file`;
};
