import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from '@rstest/core';
import semver from 'semver';
import {
  checkPackageVersion,
  checkVersion,
  formatVersionMismatch,
  NODE_RUNTIME_LABEL,
  NODE_RUNTIME_RANGE,
  SUPPORT_MATRIX,
} from '../src/shared/versionCheck';

describe('support matrix', () => {
  it('pins the launch support floors', () => {
    expect(SUPPORT_MATRIX).toEqual({
      '@rslint/core': '>=0.8.0',
      '@rstest/core': '>=0.6.0',
      rstack: '>=0.7.0',
    });
  });
});

describe('checkPackageVersion', () => {
  it('accepts versions at and above the floor', () => {
    expect(checkPackageVersion('@rslint/core', '0.8.0').kind).toBe('ok');
    expect(checkPackageVersion('@rslint/core', '1.2.3').kind).toBe('ok');
    expect(checkPackageVersion('@rstest/core', '0.11.5').kind).toBe('ok');
    expect(checkPackageVersion('rstack', '0.7.0').kind).toBe('ok');
  });

  it('accepts prereleases of a supported range', () => {
    expect(checkPackageVersion('@rstest/core', '1.0.0-beta.1').kind).toBe('ok');
  });

  it('rejects versions below the floor', () => {
    const result = checkPackageVersion('@rstest/core', '0.5.9');
    expect(result.kind).toBe('mismatch');
    if (result.kind === 'mismatch') {
      expect(formatVersionMismatch('@rstest/core', result)).toContain(
        '>=0.6.0',
      );
    }
  });

  it('never hard-fails on an unreadable version', () => {
    expect(checkPackageVersion('rstack', undefined).kind).toBe('unknown');
    expect(checkPackageVersion('rstack', 'not-a-version').kind).toBe('unknown');
  });
});

describe('node runtime range', () => {
  it('pins every edge, including the rstack engine exclusions', () => {
    expect(checkVersion('22.17.1', NODE_RUNTIME_RANGE).kind).toBe('mismatch');
    expect(checkVersion('22.18.0', NODE_RUNTIME_RANGE).kind).toBe('ok');
    expect(checkVersion('23.6.0', NODE_RUNTIME_RANGE).kind).toBe('mismatch');
    expect(checkVersion('24.2.0', NODE_RUNTIME_RANGE).kind).toBe('mismatch');
    expect(checkVersion('24.3.0', NODE_RUNTIME_RANGE).kind).toBe('ok');
  });

  it("never admits a runtime the development rstack's engines reject", () => {
    const require = createRequire(__filename);
    const packageJson = JSON.parse(
      fs.readFileSync(require.resolve('rstack/package.json'), 'utf8'),
    ) as { engines?: { node?: string } };
    const engineRange = packageJson.engines?.node;
    if (!engineRange) throw new Error('rstack does not declare engines.node');

    // This is an alarm, not an auto-move: the floor remains an ADR 0001
    // decision; this only proves it never admits a runtime rstack rejects.
    expect(semver.subset(NODE_RUNTIME_RANGE, engineRange)).toBe(true);
  });

  it('keeps the human label aligned with the range', () => {
    expect(NODE_RUNTIME_LABEL).toContain('22.18');
    expect(NODE_RUNTIME_LABEL).toContain('24.3');
    expect(NODE_RUNTIME_LABEL).not.toContain('23.');
  });
});
