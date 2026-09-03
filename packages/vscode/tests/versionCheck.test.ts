import { describe, expect, it } from '@rstest/core';
import {
  checkPackageVersion,
  checkVersion,
  formatVersionMismatch,
  NODE_RUNTIME_RANGE,
  SUPPORT_MATRIX,
} from '../src/shared/versionCheck';

describe('support matrix', () => {
  it('pins the launch support floors', () => {
    expect(SUPPORT_MATRIX).toEqual({
      '@rslint/core': '>=0.9.0',
      '@rstest/core': '>=0.6.0',
      rstack: '>=0.7.2',
    });
  });
});

describe('checkPackageVersion', () => {
  it('accepts versions at and above the floor', () => {
    expect(checkPackageVersion('@rslint/core', '0.9.0').kind).toBe('ok');
    expect(checkPackageVersion('@rslint/core', '1.2.3').kind).toBe('ok');
    expect(checkPackageVersion('@rstest/core', '0.11.5').kind).toBe('ok');
    expect(checkPackageVersion('rstack', '0.7.2').kind).toBe('ok');
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
  it('pins every edge, including the 23.x type-stripping hole', () => {
    expect(checkVersion('22.17.1', NODE_RUNTIME_RANGE).kind).toBe('mismatch');
    expect(checkVersion('22.18.0', NODE_RUNTIME_RANGE).kind).toBe('ok');
    expect(checkVersion('23.5.0', NODE_RUNTIME_RANGE).kind).toBe('mismatch');
    expect(checkVersion('23.6.0', NODE_RUNTIME_RANGE).kind).toBe('ok');
  });
});
