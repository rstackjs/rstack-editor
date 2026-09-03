import { describe, expect, it } from '@rstest/core';
import { RslintResolutionError } from '../../../src/stacks/lint/resolution';
import {
  aggregateFolderStates,
  attributeToCore,
  foldRslintFolderState,
  missingPackageOf,
  RslintVersionMismatchError,
  runningRslintStatus,
  statusForRslintStartFailure,
} from '../../../src/stacks/lint/status';

describe('Rslint status classification', () => {
  it('disables a folder whose package is not installed', () => {
    // Both not-installed shapes take the uniform disabled state (AGENTS.md):
    // a bridged folder without rstack, a fresh clone without the core. The
    // verdict rides on the error (`missingPackage`), set by the throw site.
    expect(
      statusForRslintStartFailure(
        new RslintResolutionError('missing-rstack', 'missing rstack', {
          missingPackage: 'rstack',
        }),
      ),
    ).toMatchObject({ kind: 'disabled' });
    expect(
      statusForRslintStartFailure(
        new RslintResolutionError('missing-core', 'missing core', {
          missingPackage: '@rslint/core',
        }),
      ),
    ).toMatchObject({ kind: 'disabled' });
  });

  it('names the package a not-installed failure is missing', () => {
    // The same boundary the status and the warn line use: a missing package
    // is the disabled state; a present-but-broken install is an error, so
    // the not-installed throws carry `missingPackage` and the rest do not.
    expect(
      missingPackageOf(
        new RslintResolutionError('missing-rstack', 'missing rstack', {
          missingPackage: 'rstack',
        }),
      ),
    ).toBe('rstack');
    expect(
      missingPackageOf(
        new RslintResolutionError('missing-core', 'missing core', {
          missingPackage: '@rslint/core',
        }),
      ),
    ).toBe('@rslint/core');
    expect(
      missingPackageOf(new RslintResolutionError('missing-shim', 'no shim')),
    ).toBe(undefined);
    expect(missingPackageOf(new Error('missing rstack'))).toBe(undefined);
  });

  it('classifies worker and misconfiguration failures as crashes', () => {
    expect(statusForRslintStartFailure(new Error('worker stopped'))).toEqual({
      kind: 'crashed',
      detail: 'worker stopped',
    });
    // A wrong `corePath` setting is fixed in the setting, not by an install.
    expect(
      statusForRslintStartFailure(
        new RslintResolutionError('invalid-package', 'not a core'),
      ),
    ).toEqual({ kind: 'crashed', detail: 'not a core' });
  });

  it('classifies package and automatic Node floors as version mismatches', () => {
    expect(
      statusForRslintStartFailure(
        new RslintVersionMismatchError(
          '@rslint/core 0.8.2 is not supported, this extension requires >=0.9.0',
        ),
      ),
    ).toEqual({
      kind: 'version-mismatch',
      detail:
        '@rslint/core 0.8.2 is not supported, this extension requires >=0.9.0',
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

describe('attributeToCore', () => {
  const core = '/w/packages/a/node_modules/@rslint/core';

  it('names the core a runtime failure came from', () => {
    expect(
      attributeToCore(
        { kind: 'crashed', detail: 'the Rslint language server stopped' },
        core,
      ),
    ).toEqual({
      kind: 'crashed',
      detail: `the Rslint language server stopped (${core})`,
    });
  });

  it('leaves a detail that already names the core, and healthy states, alone', () => {
    const mismatch = {
      kind: 'version-mismatch',
      detail: `@rslint/core 0.7.3 is not supported (${core})`,
    } as const;
    expect(attributeToCore(mismatch, core)).toBe(mismatch);
    const running = { kind: 'running' } as const;
    expect(attributeToCore(running, core)).toBe(running);
  });
});

describe('foldRslintFolderState', () => {
  it('reports a detected folder with no runtime as running/idle', () => {
    // Zero runtimes is the resting state since rslint #1617: a Lint runtime
    // exists only while an open document uses it. The folder is live, so the
    // kind stays `running` — "idle" is a detail, not a state of health.
    expect(foldRslintFolderState([])).toEqual({
      kind: 'running',
      detail: 'idle',
    });
  });

  it('never lets a healthy runtime mask a failing one in the same folder', () => {
    expect(
      foldRslintFolderState([
        { kind: 'running' },
        { kind: 'version-mismatch', detail: '@rslint/core 0.7.3 (/a/core)' },
        { kind: 'running' },
      ]),
    ).toEqual({
      kind: 'version-mismatch',
      detail: '@rslint/core 0.7.3 (/a/core)',
    });
  });

  it('joins every detail sharing the worst kind, once each', () => {
    expect(
      foldRslintFolderState([
        { kind: 'crashed', detail: 'left died' },
        { kind: 'crashed', detail: 'right died' },
        { kind: 'crashed', detail: 'left died' },
        { kind: 'starting' },
      ]),
    ).toEqual({ kind: 'crashed', detail: 'left died | right died' });
  });

  it('folds a failed resolution beside the runtime the document kept', () => {
    // Last-good semantics: the runtime stays up, and the failure is still the
    // folder's worst news — reported as status, never as a toast.
    expect(
      foldRslintFolderState([
        { kind: 'running' },
        { kind: 'crashed', detail: 'Could not resolve @rslint/core from /b' },
      ]),
    ).toEqual({
      kind: 'crashed',
      detail: 'Could not resolve @rslint/core from /b',
    });
  });

  it('lets a bridged folder that lost rstack outrank its live runtime', () => {
    // Inside a folder `disabled` only ever means "a package is not
    // installed" — a failure the user must see, not the shell's kill switch —
    // so, unlike the cross-folder rank, it beats a healthy runtime.
    expect(
      foldRslintFolderState([
        { kind: 'running' },
        { kind: 'disabled', reason: 'rstack is not installed in /w' },
      ]),
    ).toEqual({ kind: 'disabled', reason: 'rstack is not installed in /w' });
  });
});

describe('aggregateFolderStates', () => {
  it('names the folder a failure came from in a multi-root workspace', () => {
    expect(
      aggregateFolderStates([
        { name: 'app', state: { kind: 'running', detail: 'idle' } },
        { name: 'lib', state: { kind: 'crashed', detail: 'worker exited' } },
      ]),
    ).toEqual({ kind: 'crashed', detail: 'lib: worker exited' });
  });

  it('keeps a single-root detail unprefixed', () => {
    expect(
      aggregateFolderStates([
        { name: 'app', state: { kind: 'running', detail: 'idle' } },
      ]),
    ).toEqual({ kind: 'running', detail: 'idle' });
  });

  it('reports starting before any folder registered', () => {
    expect(aggregateFolderStates([])).toEqual({ kind: 'starting' });
  });
});
