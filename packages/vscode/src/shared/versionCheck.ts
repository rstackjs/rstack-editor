import semver from 'semver';
import { readPackageJson } from './packageResolve';

/**
 * The version-compatibility contract. A VSIX has no npm install step,
 * so the packages below are resolved from the user's project at runtime and
 * checked against this matrix; a mismatch surfaces as the `version mismatch`
 * status bar state with actual vs required versions.
 *
 * Launch floors (verified against npm):
 * - `@rslint/core >= 0.7.2` — first version whose package exports
 *   `./config-loader` and `./eslint-plugin`.
 * - `@rstest/core >= 0.6.0` — the existing `MIN_CORE_VERSION` upstream.
 * - `rstack >= 0.3.5` — first release with the full supported config and
 *   formatter surface.
 */
export const SUPPORT_MATRIX = {
  '@rslint/core': '>=0.7.2',
  '@rstest/core': '>=0.6.0',
  rstack: '>=0.3.5',
} as const;

export type SupportedPackage = keyof typeof SUPPORT_MATRIX;

export type VersionCheckResult =
  | { readonly kind: 'ok'; readonly version: string }
  /** The version could not be read; never treated as a hard failure. */
  | { readonly kind: 'unknown'; readonly version?: string }
  | {
      readonly kind: 'mismatch';
      readonly version: string;
      readonly required: string;
    };

/**
 * Reads a package.json `version` uncached (see `readPackageJson`). Returns
 * `undefined` when unreadable — version checks treat an unknown version as
 * soft-pass, so an unreadable package.json only costs the check, never the
 * feature.
 */
export const readPackageVersion = (
  packageJsonPath: string,
): string | undefined => {
  const version = readPackageJson(packageJsonPath)?.version;
  return typeof version === 'string' ? version : undefined;
};

/**
 * The floor for the Node.js a test worker runs on. Not part of
 * `SUPPORT_MATRIX`, which is keyed by npm package name, but the same kind of
 * fact and deliberately kept in the same file so "what does this extension
 * require?" has one answer.
 *
 * Native type stripping is what lets a worker load an `rstack.config.*` —
 * rstack's shim loads it with `loader: 'native'` and no jiti fallback. It was
 * unflagged in 23.6.0 and backported to the LTS line in 22.18.0, so 23.0–23.5
 * compare above 22.18.0 yet predate it — hence a disjunction, not a plain
 * floor. Verified: 22.17.1 reports `process.features.typescript` false,
 * 22.18.0 reports `strip`. See `stacks/test/nodeResolution.ts` for how
 * candidates are probed.
 */
export const NODE_RUNTIME_RANGE = '^22.18.0 || >=23.6.0';

/**
 * `NODE_RUNTIME_RANGE` for human eyes, interpolated into the user-facing
 * messages in `stacks/test/nodeResolution.ts`. The raw range reads as npm
 * jargon in a status-bar sentence — a user on 23.2 would have to parse a `^`
 * to learn why they were refused. Logs keep the raw range, the precise
 * register there. Keep the two in lockstep.
 */
export const NODE_RUNTIME_LABEL = '22.18+ (excluding 23.0–23.5)';

/**
 * Classifies a version against a range; it does not decide what the classes
 * mean. Prereleases of a supported range (e.g. `1.0.0-beta.1`) count as `ok`,
 * because the ecosystem ships them and refusing them would strand early
 * adopters — that part *is* policy and is uniform.
 *
 * What `unknown` means is the caller's to choose, and the two callers choose
 * opposite things on purpose:
 * - `reportVersionCheck` below soft-passes it. A package whose version cannot
 *   be read is still installed, and there is no second candidate to fall back
 *   to, so refusing would cost the feature for nothing.
 * - `satisfiesFloor` in `stacks/test/nodeResolution.ts` rejects it. Runtime
 *   candidates are an *ordered list*, so soft-passing lets a suspect PATH
 *   `node` win over a healthy one from the user's shell.
 *
 * A third caller must make this choice deliberately rather than copy whichever
 * neighbour it read first.
 */
export const checkVersion = (
  version: string | undefined,
  required: string,
): VersionCheckResult => {
  if (!version || !semver.valid(semver.coerce(version) ?? '')) {
    return { kind: 'unknown', version };
  }
  if (semver.satisfies(version, required, { includePrerelease: true })) {
    return { kind: 'ok', version };
  }
  return { kind: 'mismatch', version, required };
};

export const checkPackageVersion = (
  packageName: SupportedPackage,
  version: string | undefined,
): VersionCheckResult => checkVersion(version, SUPPORT_MATRIX[packageName]);

export const formatVersionMismatch = (
  packageName: SupportedPackage,
  result: Extract<VersionCheckResult, { kind: 'mismatch' }>,
): string =>
  `${packageName} ${result.version} is not supported, this extension requires ${result.required}`;

/**
 * Checks one project-resolved package and reports a mismatch through the
 * shared status reporter. Returns `true` when the stack may keep going.
 *
 * `source` identifies the resolution root on reporters that latch mismatches
 * per root (`stacks/test/status.ts`); plain `StatusReporter`s ignore it.
 */
export const reportVersionCheck = (
  status: { versionMismatch(detail: string, source?: string): void },
  packageName: SupportedPackage,
  version: string | undefined,
  source?: string,
): boolean => {
  const result = checkPackageVersion(packageName, version);
  if (result.kind === 'mismatch') {
    status.versionMismatch(formatVersionMismatch(packageName, result), source);
    return false;
  }
  return true;
};

/**
 * The reverse config-discovery protocol between the Rslint Go server and the
 * project-resolved `@rslint/core/config-loader` is versioned independently of
 * the package version, so `semver.satisfies` is necessary but
 * not sufficient: the client additionally validates the `protocolVersion`
 * carried by `rslint/configRefresh`.
 */
export const SUPPORTED_CONFIG_DISCOVERY_PROTOCOL_VERSIONS: ReadonlySet<number> =
  new Set([1]);

export const isSupportedConfigDiscoveryProtocolVersion = (
  version: number,
): boolean => SUPPORTED_CONFIG_DISCOVERY_PROTOCOL_VERSIONS.has(version);

export const formatProtocolVersionMismatch = (version: number): string =>
  `Rslint config-discovery protocol version ${version} is not supported (supported: ${[
    ...SUPPORTED_CONFIG_DISCOVERY_PROTOCOL_VERSIONS,
  ].join(', ')})`;
