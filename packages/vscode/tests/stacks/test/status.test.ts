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
    const calls = bindRecorder();
    status.running();
    expect(calls).toEqual(['running:']);
  });
});
