import semver from 'semver';

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
 * - `rstack >= 0.3.2` — first release containing `rs fmt --stdin-filepath`.
 */
export const SUPPORT_MATRIX = {
  '@rslint/core': '>=0.7.2',
  '@rstest/core': '>=0.6.0',
  rstack: '>=0.3.2',
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

export const checkPackageVersion = (
  packageName: SupportedPackage,
  version: string | undefined,
): VersionCheckResult => {
  if (!version || !semver.valid(semver.coerce(version) ?? '')) {
    return { kind: 'unknown', version };
  }
  const required = SUPPORT_MATRIX[packageName];
  // Prereleases of a supported range (e.g. `1.0.0-beta.1`) are accepted: the
  // ecosystem ships them and refusing them would strand early adopters.
  if (semver.satisfies(version, required, { includePrerelease: true })) {
    return { kind: 'ok', version };
  }
  return { kind: 'mismatch', version, required };
};

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
