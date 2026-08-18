import { describe, expect, it } from '@rstest/core';
import { RslintResolutionError } from '../../../src/stacks/lint/resolution';
import {
  RslintVersionMismatchError,
  runningRslintStatus,
  statusForRslintStartFailure,
} from '../../../src/stacks/lint/status';

describe('Rslint status classification', () => {
  it('disables a bridged folder whose rstack package is missing', () => {
    expect(
      statusForRslintStartFailure(
        new RslintResolutionError('missing-rstack', 'missing rstack'),
      ),
    ).toMatchObject({ kind: 'disabled' });
  });

  it('classifies missing core and worker failures as crashes', () => {
    expect(
      statusForRslintStartFailure(
        new RslintResolutionError('missing-core', 'missing core'),
      ),
    ).toEqual({ kind: 'crashed', detail: 'missing core' });
    expect(statusForRslintStartFailure(new Error('worker stopped'))).toEqual({
      kind: 'crashed',
      detail: 'worker stopped',
    });
  });

  it('classifies package and automatic Node floors as version mismatches', () => {
    expect(
      statusForRslintStartFailure(
        new RslintVersionMismatchError(
          '@rslint/core 0.7.3 is not supported, this extension requires >=0.8.0',
        ),
      ),
    ).toEqual({
      kind: 'version-mismatch',
      detail:
        '@rslint/core 0.7.3 is not supported, this extension requires >=0.8.0',
    });
  });

  it('surfaces a configured Node advisory without stopping the worker', () => {
    expect(runningRslintStatus()).toEqual({ kind: 'running' });
    expect(runningRslintStatus('Node 22.17 is below the floor')).toEqual({
      kind: 'version-mismatch',
      detail: 'Node 22.17 is below the floor',
    });
  });
});
