import { describe, expect, it } from '@rstest/core';
import {
  foldFolderStatus,
  type FmtFolderStatus,
  type FmtRuntimeState,
} from '../../../src/stacks/fmt/status';

const folder = (
  name: string,
  state: FmtRuntimeState,
  overrides: Partial<Pick<FmtFolderStatus, 'detail' | 'advisory'>> = {},
): FmtFolderStatus => ({
  name,
  state,
  detail: overrides.detail ?? '',
  advisory: overrides.advisory,
});

const DETECTED = 'detected in app';

describe('foldFolderStatus', () => {
  it('reports starting before any runtime exists', () => {
    // The moment between registration and the first reconcile: folders are
    // detected, no server has been scheduled yet — the formatter is not
    // available and the status must not claim it is.
    expect(foldFolderStatus([], DETECTED)).toEqual({
      kind: 'starting',
      detail: DETECTED,
    });
  });

  it('reports starting until every folder is running', () => {
    expect(
      foldFolderStatus(
        [folder('a', 'running'), folder('b', 'starting')],
        DETECTED,
      ).kind,
    ).toBe('starting');
    // A restart passes through `stopped` on its way back up — same truth.
    expect(
      foldFolderStatus(
        [folder('a', 'running'), folder('b', 'stopped')],
        DETECTED,
      ).kind,
    ).toBe('starting');
  });

  it('reports running with the detection reason when every folder runs clean', () => {
    expect(
      foldFolderStatus(
        [folder('a', 'running'), folder('b', 'running')],
        DETECTED,
      ),
    ).toEqual({ kind: 'running', detail: DETECTED });
  });

  it("never lets a healthy sibling mask another folder's failure", () => {
    // The invariant this module exists for: the fold's answer must not depend
    // on which folder reported last, so a failure wins from either side.
    const crashed = folder('bad', 'crashed', { detail: 'server stopped' });
    const running = folder('good', 'running');
    for (const statuses of [
      [crashed, running],
      [running, crashed],
    ]) {
      expect(foldFolderStatus(statuses, DETECTED)).toEqual({
        kind: 'crashed',
        detail: 'bad: server stopped',
      });
    }
  });

  it('ranks crashed over version-mismatch over disabled', () => {
    const statuses = [
      folder('a', 'disabled', { detail: 'rstack is not installed' }),
      folder('b', 'crashed', { detail: 'server stopped' }),
      folder('c', 'version-mismatch', { detail: 'rstack 0.4.0 unsupported' }),
    ];
    expect(foldFolderStatus(statuses, DETECTED).kind).toBe('crashed');
    expect(foldFolderStatus(statuses.slice(0, 1), DETECTED)).toEqual({
      kind: 'disabled',
      reason: 'rstack is not installed',
    });
  });

  it('shows a disabled folder over a running sibling', () => {
    // Unlike the shell's kill-switch `disabled`, this one means "this folder
    // will never format" — worth showing over a healthy sibling.
    expect(
      foldFolderStatus(
        [
          folder('good', 'running'),
          folder('bare', 'disabled', { detail: 'rstack is not installed' }),
        ],
        DETECTED,
      ),
    ).toEqual({ kind: 'disabled', reason: 'bare: rstack is not installed' });
  });

  it('prefixes folder names only in a multi-root window, joining ties', () => {
    const detail = 'server stopped';
    expect(
      foldFolderStatus([folder('only', 'crashed', { detail })], DETECTED),
    ).toEqual({ kind: 'crashed', detail });
    expect(
      foldFolderStatus(
        [
          folder('a', 'crashed', { detail }),
          folder('b', 'crashed', { detail }),
        ],
        DETECTED,
      ),
    ).toEqual({
      kind: 'crashed',
      detail: 'a: server stopped | b: server stopped',
    });
  });

  it('folds a running folder with a pin advisory as a version-mismatch', () => {
    // The server formats — the state stays `running` for the E2E exports —
    // but the status carries the warning, at the same rank as the test
    // stack's configured-pin advisory: above `disabled`, below `crashed`.
    const advisory = 'node 20.19.4 is below the floor; using it anyway';
    expect(
      foldFolderStatus(
        [
          folder('pinned', 'running', { advisory }),
          folder('bare', 'disabled', { detail: 'rstack is not installed' }),
        ],
        DETECTED,
      ),
    ).toEqual({ kind: 'version-mismatch', detail: `pinned: ${advisory}` });
  });
});
