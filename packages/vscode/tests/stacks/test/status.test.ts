import { describe, expect, it } from '@rstest/core';
import type { StatusReporter } from '../../../src/types';
import { status } from '../../../src/stacks/test/status';

// `status` is a module singleton; `bind()` resets the latches, so each test
// binds its own recorder and starts from a clean slate.
const bindRecorder = () => {
  const calls: string[] = [];
  const reporter: StatusReporter = {
    stack: 'rstest',
    report: (state) => calls.push(`report:${state.kind}`),
    starting: (detail) => calls.push(`starting:${detail ?? ''}`),
    running: (detail) => calls.push(`running:${detail ?? ''}`),
    crashed: (detail) => calls.push(`crashed:${detail}`),
    versionMismatch: (detail) => calls.push(`mismatch:${detail}`),
  };
  status.bind(reporter);
  return calls;
};

describe('StatusHolder failure latches', () => {
  it('keeps a mismatch latched across detection-driven running repaints', () => {
    const calls = bindRecorder();
    status.versionMismatch('core too old', '/a');
    status.running('2 folders');
    status.starting();
    expect(calls).toEqual(['mismatch:core too old']);
  });

  it('does not clear one root’s mismatch when another root passes its check', () => {
    const calls = bindRecorder();
    status.versionMismatch('core too old', '/a');
    status.versionOk('/b');
    status.running('2 folders');
    expect(calls).toEqual(['mismatch:core too old']);

    status.versionOk('/a');
    expect(calls).toEqual(['mismatch:core too old', 'running:2 folders']);
  });

  it('does not clear one root’s crash when another root’s worker spawns', () => {
    const calls = bindRecorder();
    status.crashed('spawn ENOENT', '/a');
    status.workerSpawned('/b');
    status.running();
    expect(calls).toEqual(['crashed:spawn ENOENT']);

    status.workerSpawned('/a');
    expect(calls).toEqual(['crashed:spawn ENOENT', 'running:']);
  });

  it('lets the package-state verdicts supersede each other per root', () => {
    // Mismatch and not-installed describe the same fact — the root's package
    // — and are mutually exclusive: without the supersession the stale
    // higher-ranked mismatch would keep painting the upgrade hint after the
    // package is removed.
    const calls = bindRecorder();
    status.versionMismatch('rstack too old', '/a');
    status.notInstalled('rstack is not installed', '/a');
    expect(calls).toEqual(['mismatch:rstack too old', 'report:disabled']);

    status.versionMismatch('rstack too old', '/a');
    expect(calls.slice(2)).toEqual(['mismatch:rstack too old']);
  });

  it('lets a package-state observation retire a stale crash', () => {
    // The crash's only other exit is `workerSpawned`, which cannot happen
    // while the package is unusable — a fresh resolution verdict restates
    // the root, so the crash must not outlive it and paint over `disabled`.
    const calls = bindRecorder();
    status.crashed('spawn ENOENT', '/a');
    status.notInstalled('rstack is not installed', '/a');
    expect(calls).toEqual(['crashed:spawn ENOENT', 'report:disabled']);
  });

  it('outranks a mismatch with a crash and falls back on recovery', () => {
    const calls = bindRecorder();
    status.versionMismatch('core too old', '/a');
    status.crashed('spawn ENOENT', '/b');
    status.workerSpawned('/b');
    expect(calls).toEqual([
      'mismatch:core too old',
      'crashed:spawn ENOENT',
      'mismatch:core too old',
    ]);
  });

  it('replays the latest running detail once every latch clears', () => {
    const calls = bindRecorder();
    status.crashed('spawn ENOENT', '/a');
    status.running('3 folders');
    status.workerSpawned('/a');
    expect(calls).toEqual(['crashed:spawn ENOENT', 'running:3 folders']);
  });

  it('forgets a removed root’s failures and repaints', () => {
    const calls = bindRecorder();
    status.versionMismatch('core too old', '/a');
    status.crashed('spawn ENOENT', '/a');
    status.running('1 folder');
    status.forget('/a');
    expect(calls).toEqual([
      'mismatch:core too old',
      'crashed:spawn ENOENT',
      'running:1 folder',
    ]);
  });

  it('forget of an unknown root does not repaint', () => {
    const calls = bindRecorder();
    status.versionMismatch('core too old', '/a');
    status.forget('/b');
    expect(calls).toEqual(['mismatch:core too old']);
  });

  it('drops stale latches on bind', () => {
    bindRecorder();
    status.versionMismatch('core too old', '/a');
    status.notInstalled('core missing', '/b');
    const calls = bindRecorder();
    status.running();
    expect(calls).toEqual(['running:']);
  });

  it('paints a missing install as disabled and keeps it across running repaints', () => {
    const calls = bindRecorder();
    status.notInstalled('core missing', '/a');
    status.running('2 folders');
    status.starting();
    expect(calls).toEqual(['report:disabled']);
  });

  it('ranks a missing install below a mismatch and a crash', () => {
    const calls = bindRecorder();
    status.notInstalled('core missing', '/a');
    status.versionMismatch('core too old', '/b');
    status.crashed('spawn ENOENT', '/c');
    status.workerSpawned('/c');
    status.versionOk('/b');
    expect(calls).toEqual([
      'report:disabled',
      'mismatch:core too old',
      'crashed:spawn ENOENT',
      'mismatch:core too old',
      'report:disabled',
    ]);
  });

  it('clears one root’s missing install without touching another’s', () => {
    const calls = bindRecorder();
    status.notInstalled('core missing', '/a');
    status.installed('/b');
    status.running('2 folders');
    expect(calls).toEqual(['report:disabled']);

    status.installed('/a');
    expect(calls).toEqual(['report:disabled', 'running:2 folders']);
  });

  it('forgets a removed root’s missing install and repaints', () => {
    const calls = bindRecorder();
    status.notInstalled('core missing', '/a');
    status.running('1 folder');
    status.forget('/a');
    expect(calls).toEqual(['report:disabled', 'running:1 folder']);
  });
});
