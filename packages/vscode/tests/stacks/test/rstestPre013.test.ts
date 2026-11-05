import { describe, expect, it } from '@rstest/core';
import {
  normalizeTestResultStatus,
  normalizeTestRunStatus,
} from '../../../src/stacks/test/compat/rstestPre013';

// COMPAT(rstest<0.13): this file is deleted with the compat module.

describe('normalizeTestResultStatus', () => {
  it.each([
    // Latest vocabulary (rstest >= 0.13) passes through.
    ['passed', 'passed'],
    ['failed', 'failed'],
    ['skipped', 'skipped'],
    ['todo', 'todo'],
    // Legacy vocabulary (rstest < 0.13).
    ['pass', 'passed'],
    ['fail', 'failed'],
    ['skip', 'skipped'],
  ])('maps %s to %s', (status, expected) => {
    expect(normalizeTestResultStatus(status)).toBe(expected);
  });

  it.each(['pending', '', 'PASSED', 'unknown'])(
    'returns undefined for the unknown status %s',
    (status) => {
      expect(normalizeTestResultStatus(status)).toBeUndefined();
    },
  );
});

describe('normalizeTestRunStatus', () => {
  it.each([
    ['passed', 'passed'],
    ['failed', 'failed'],
    ['error', 'error'],
    ['pass', 'passed'],
    ['fail', 'failed'],
  ])('maps %s to %s', (status, expected) => {
    expect(normalizeTestRunStatus(status)).toBe(expected);
  });

  it.each(['skip', 'todo', 'skipped', 'unknown'])(
    'returns undefined for the non-run status %s',
    (status) => {
      expect(normalizeTestRunStatus(status)).toBeUndefined();
    },
  );
});
