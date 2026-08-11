import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from '@rstest/core';
import { NODE_RUNTIME_RANGE } from '../../../src/shared/versionCheck';
import {
  configuredNodeBelowFloor,
  END_TOKEN,
  type NodeProbe,
  NodePreflightError,
  probeNodeVersion,
  probeShellNodePath,
  type ResolveWorkerNodeOptions,
  resetWorkerNodeCaches,
  resolveWorkerNode,
  resolveWorkerNodeOnce,
  START_TOKEN,
} from '../../../src/stacks/test/nodeResolution';

// Every case injects both probes: the point is the decision table, not the
// spawning, which the two real-process describes at the bottom cover.
const versionsOf =
  (table: Record<string, NodeProbe>) =>
  (executable: string): Promise<NodeProbe> =>
    Promise.resolve(table[executable] ?? { kind: 'not-found' });

const shellFinds =
  (path: string | undefined) => (): Promise<string | undefined> =>
    Promise.resolve(path);

const never = () => {
  throw new Error('the shell probe should not have been called');
};

const ok = (version: string): NodeProbe => ({ kind: 'ok', version });

const base = { shell: '/bin/zsh' } as const;

/** Asserts the call rejects, and hands back the error already narrowed. */
const preflightError = (
  options: ResolveWorkerNodeOptions,
): Promise<NodePreflightError> =>
  resolveWorkerNode(options).then(
    () => {
      throw new Error('expected a NodePreflightError');
    },
    (error: unknown) => error as NodePreflightError,
  );

describe('resolveWorkerNode', () => {
  it('uses the PATH node when it satisfies the floor', async () => {
    const resolution = await resolveWorkerNode({
      ...base,
      probe: versionsOf({ node: ok('22.18.0') }),
      probeShellPath: never,
    });
    expect(resolution).toEqual({
      executable: 'node',
      source: 'path',
      version: '22.18.0',
    });
  });

  it('falls through a PATH node whose version cannot be parsed', async () => {
    // Runtime policy deliberately diverges from the package checks in
    // `shared/versionCheck`, which soft-pass an unknown version: candidates
    // here are an ordered list, so a soft pass would let a suspect PATH node
    // beat a healthy one from the user's shell. A package check has no next
    // candidate to fall through to.
    const resolution = await resolveWorkerNode({
      ...base,
      probe: versionsOf({
        node: { kind: 'ok' },
        '/versions/24/bin/node': ok('24.0.0'),
      }),
      probeShellPath: shellFinds('/versions/24/bin/node'),
    });
    expect(resolution.source).toBe('shell');
  });

  it('fails rather than run on a node nobody could version', async () => {
    const error = await preflightError({
      ...base,
      probe: versionsOf({ node: { kind: 'ok' } }),
      probeShellPath: shellFinds(undefined),
    });
    expect(error.attempts.path).toBeUndefined();
  });

  it('accepts a prerelease of a satisfying version', async () => {
    // The shared `checkVersion` passes `includePrerelease: true`; this pins
    // that the node floor now follows the same rule as every package floor.
    const resolution = await resolveWorkerNode({
      ...base,
      probe: versionsOf({ node: ok('23.0.0-nightly20260101') }),
      probeShellPath: never,
    });
    expect(resolution.source).toBe('path');
  });

  it('falls back to the shell node when the PATH node is too old', async () => {
    const resolution = await resolveWorkerNode({
      ...base,
      probe: versionsOf({
        node: ok('20.19.4'),
        '/versions/24/bin/node': ok('24.0.0'),
      }),
      probeShellPath: shellFinds('/versions/24/bin/node'),
    });
    expect(resolution).toEqual({
      executable: '/versions/24/bin/node',
      source: 'shell',
      version: '24.0.0',
    });
  });

  it('falls back to the shell node when no PATH node runs at all', async () => {
    const resolution = await resolveWorkerNode({
      ...base,
      probe: versionsOf({ '/versions/24/bin/node': ok('24.0.0') }),
      probeShellPath: shellFinds('/versions/24/bin/node'),
    });
    expect(resolution.source).toBe('shell');
  });

  it('retries a not-found PATH node before giving up on it', async () => {
    // VS Code resolves the shell env while extensions are already activating,
    // so an installed node can be absent for the first moments of a session.
    let calls = 0;
    const resolution = await resolveWorkerNode({
      ...base,
      probe: (executable) => {
        if (executable !== 'node')
          return Promise.resolve({ kind: 'not-found' });
        calls++;
        return Promise.resolve(
          calls < 3 ? { kind: 'not-found' } : ok('24.0.0'),
        );
      },
      probeShellPath: never,
    });
    expect(resolution.source).toBe('path');
    expect(calls).toBe(3);
  });

  it('does not retry a node that ran and failed', async () => {
    // Retrying only helps a PATH that is not populated yet. An executable that
    // exists but hangs would otherwise cost the probe timeout six times over.
    let calls = 0;
    const error = await preflightError({
      ...base,
      probe: (executable) => {
        if (executable !== 'node')
          return Promise.resolve({ kind: 'not-found' });
        calls++;
        return Promise.resolve({ kind: 'unusable' });
      },
      probeShellPath: shellFinds(undefined),
    });
    expect(calls).toBe(1);
    expect(error.attempts.path).toBeUndefined();
  });

  it('skips the shell probe on Windows', async () => {
    const error = await preflightError({
      ...base,
      platform: 'win32',
      probe: versionsOf({ node: ok('20.19.4') }),
      probeShellPath: never,
    });
    expect(error.attempts).toEqual({
      path: '20.19.4',
      shell: undefined,
      shellSkipped: true,
    });
  });

  it('skips the shell probe when no shell is known', async () => {
    const error = await preflightError({
      probe: versionsOf({ node: ok('20.19.4') }),
      probeShellPath: never,
    });
    expect(error.attempts.shellSkipped).toBe(true);
  });

  it('reports both candidates when the shell node is also too old', async () => {
    const error = await preflightError({
      ...base,
      probe: versionsOf({
        node: ok('20.19.4'),
        '/versions/22/bin/node': ok('22.14.0'),
      }),
      probeShellPath: shellFinds('/versions/22/bin/node'),
    });
    expect(error.attempts).toEqual({
      path: '20.19.4',
      shell: '22.14.0',
      shellSkipped: false,
    });
  });

  it('reports a shell that found nothing', async () => {
    const error = await preflightError({
      ...base,
      probe: versionsOf({ node: ok('20.19.4') }),
      probeShellPath: shellFinds(undefined),
    });
    expect(error.attempts).toEqual({
      path: '20.19.4',
      shell: undefined,
      shellSkipped: false,
    });
  });
});

describe('NodePreflightError', () => {
  it('names the floor, both candidates and the setting to change', () => {
    const { message } = new NodePreflightError({
      path: '20.19.4',
      shell: '22.14.0',
      shellSkipped: false,
    });
    expect(message).toContain(NODE_RUNTIME_RANGE);
    expect(message).toContain('PATH: 20.19.4');
    expect(message).toContain('interactive shell: 22.14.0');
    expect(message).toContain('rstack.rstest.nodeExecutable');
  });

  it('states the consequence, which is what a below-floor setting does not', () => {
    // Both failures reach the user through the same `version-mismatch` status,
    // so the consequence clause is the only thing distinguishing "nothing will
    // run" from "we are running with it anyway".
    const { message } = new NodePreflightError({
      path: '20.19.4',
      shell: undefined,
      shellSkipped: false,
    });
    expect(message).toContain('tests will not run');
  });

  it('does not invent versions for candidates that found nothing', () => {
    const { message } = new NodePreflightError({
      path: undefined,
      shell: undefined,
      shellSkipped: false,
    });
    expect(message).toContain('PATH: none found');
    expect(message).not.toContain('undefined');
  });

  it('says the shell was not probed without blaming Windows', () => {
    // `shellSkipped` also covers "no known shell" on macOS/Linux, so the text
    // must not claim a platform it cannot know.
    const { message } = new NodePreflightError({
      path: '20.19.4',
      shell: undefined,
      shellSkipped: true,
    });
    expect(message).toContain('interactive shell: not probed');
    expect(message).not.toContain('Windows');
  });
});

describe('resolveWorkerNodeOnce', () => {
  afterEach(() => {
    resetWorkerNodeCaches();
  });

  const options = {
    ...base,
    probe: versionsOf({ node: ok('24.0.0') }),
    probeShellPath: never,
  };

  it('probes once for the whole extension host and re-probes after a reset', async () => {
    const first = await resolveWorkerNodeOnce(options);
    const second = await resolveWorkerNodeOnce(options);
    expect(second).toBe(first);

    resetWorkerNodeCaches();
    const third = await resolveWorkerNodeOnce(options);
    expect(third).not.toBe(first);
  });

  it('memoizes the rejection, so a broken host pays the probes once', async () => {
    let calls = 0;
    const failing = {
      ...base,
      probe: () => {
        calls++;
        return Promise.resolve<NodeProbe>(ok('20.19.4'));
      },
      probeShellPath: shellFinds(undefined),
    };
    await resolveWorkerNodeOnce(failing).catch(() => {});
    await resolveWorkerNodeOnce(failing).catch(() => {});
    expect(calls).toBe(1);
  });

  it('announces the shell fallback exactly once', async () => {
    // The notice lives inside the memo, so "probed once" and "announced once"
    // are the same guarantee — this is what keeps a 20-project monorepo from
    // logging the fallback 20 times.
    const notices: string[] = [];
    const shellOptions = {
      ...base,
      probe: versionsOf({
        node: ok('20.19.4'),
        '/versions/24/bin/node': ok('24.0.0'),
      }),
      probeShellPath: shellFinds('/versions/24/bin/node'),
      notify: (message: string) => notices.push(message),
    };

    await resolveWorkerNodeOnce(shellOptions);
    await resolveWorkerNodeOnce(shellOptions);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('/versions/24/bin/node');
  });

  it('stays silent when the PATH node was good enough', async () => {
    const notices: string[] = [];
    await resolveWorkerNodeOnce({
      ...options,
      notify: (message) => notices.push(message),
    });
    expect(notices).toHaveLength(0);
  });

  it('shares one in-flight probe across concurrent callers', async () => {
    // N projects are constructed in one synchronous loop, so they all reach
    // the memo before the first probe settles.
    let calls = 0;
    const slow = {
      ...base,
      probe: () => {
        calls++;
        return new Promise<NodeProbe>((resolve) =>
          setTimeout(() => resolve(ok('24.0.0')), 10),
        );
      },
      probeShellPath: never,
    };
    const all = await Promise.all(
      Array.from({ length: 20 }, () => resolveWorkerNodeOnce(slow)),
    );
    expect(calls).toBe(1);
    expect(new Set(all).size).toBe(1);
  });
});

describe('configuredNodeBelowFloor', () => {
  afterEach(() => {
    resetWorkerNodeCaches();
  });

  const configured = '/opt/node/bin/node';
  const answers = (probe: NodeProbe) => ({
    probe: () => Promise.resolve(probe),
  });

  it('passes an explicit executable that clears the floor', async () => {
    expect(
      await configuredNodeBelowFloor(configured, answers(ok('24.0.0'))),
    ).toBeUndefined();
  });

  it('names the version, the floor and the setting, and says the run goes ahead', async () => {
    const message = await configuredNodeBelowFloor(
      configured,
      answers(ok('20.19.4')),
    );
    expect(message).toContain(configured);
    expect(message).toContain('20.19.4');
    expect(message).toContain(NODE_RUNTIME_RANGE);
    expect(message).toContain('rstack.rstest.nodeExecutable');
    // The opposite consequence from `NodePreflightError`: this one runs.
    expect(message).toContain('running tests with it anyway');
  });

  it('reports an executable that cannot answer at all', async () => {
    // Same policy as the ordered candidate list: an unreadable version is not
    // a pass. Nothing is claimed about a version that was never read.
    const message = await configuredNodeBelowFloor(
      configured,
      answers({ kind: 'not-found' }),
    );
    expect(message).toContain('version unknown');
  });

  it('probes one executable once, until the cache is reset', async () => {
    // `resolveWorkerNodeCommand` runs on every worker spawn, so an unmemoized
    // probe would be a process spawn per config init, per list, per run.
    let calls = 0;
    const counting = {
      probe: () => {
        calls++;
        return Promise.resolve<NodeProbe>(ok('24.0.0'));
      },
    };
    await configuredNodeBelowFloor(configured, counting);
    await configuredNodeBelowFloor(configured, counting);
    expect(calls).toBe(1);

    resetWorkerNodeCaches();
    await configuredNodeBelowFloor(configured, counting);
    expect(calls).toBe(2);
  });

  it('keeps one verdict per executable, for a multi-root window', async () => {
    expect(
      await configuredNodeBelowFloor('/opt/old/node', answers(ok('20.19.4'))),
    ).toBeDefined();
    expect(
      await configuredNodeBelowFloor('/opt/new/node', answers(ok('24.0.0'))),
    ).toBeUndefined();
  });
});

describe('probeNodeVersion', () => {
  it('reads the version of a real node executable', async () => {
    // The test run's own node is the one binary guaranteed to exist.
    const probe = await probeNodeVersion(process.execPath);
    expect(probe).toEqual({ kind: 'ok', version: process.versions.node });
  });

  it('reports a nonexistent executable as not-found, so it is retried', async () => {
    const probe = await probeNodeVersion('/nonexistent/definitely-not-node');
    expect(probe).toEqual({ kind: 'not-found' });
  });

  it('reports an executable that exits non-zero as unusable, not retried', async () => {
    const probe = await probeNodeVersion('/usr/bin/false');
    expect(probe.kind === 'unusable' || probe.kind === 'not-found').toBe(true);
  });
});

describe('probeShellNodePath', () => {
  it('returns undefined when the shell itself cannot be run', async () => {
    const found = await probeShellNodePath(
      '/nonexistent/definitely-not-a-shell',
    );
    expect(found).toBeUndefined();
  });

  it('slices the answer out of a real shell run', async () => {
    if (process.platform === 'win32') return;
    // `sh` runs the script and `command -v node` resolves against the test
    // run's own PATH, which necessarily has a node on it.
    const found = await probeShellNodePath('/bin/sh');
    expect(found).toBeDefined();
    expect(found?.startsWith('/')).toBe(true);
  });

  // A stand-in shell answering one fixed line, run from a fresh tmpdir. The
  // tmpdir is realpath'd up front so `$PWD` (from getcwd(), symlinks
  // resolved) compares against `dir` directly.
  const probeFakeShell = async (
    answer: string,
  ): Promise<{ found: string | undefined; dir: string }> => {
    const dir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), 'rstack-shell-probe-'),
    );
    try {
      const fakeShell = path.join(dir, 'answer-shell');
      fs.writeFileSync(
        fakeShell,
        `#!/bin/sh\necho ${START_TOKEN}\necho "${answer}"\necho ${END_TOKEN}\n`,
        { mode: 0o755 },
      );
      return { found: await probeShellNodePath(fakeShell, dir), dir };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('stands the spawned shell in the given cwd', async () => {
    if (process.platform === 'win32') return;
    // The answer is the one thing the real script's `command -v` resolves
    // against that the caller controls; a wrong or dropped cwd makes the
    // paths disagree.
    const { found, dir } = await probeFakeShell('$PWD/node');
    expect(found).toBe(path.join(dir, 'node'));
  });

  it('anchors a relative answer to the probe cwd', async () => {
    if (process.platform === 'win32') return;
    // A relative PATH entry makes `command -v` legitimately answer e.g.
    // `bin/node` — which is what a terminal opened in the probe cwd would
    // run, so that is where it anchors.
    const { found, dir } = await probeFakeShell('bin/node');
    expect(found).toBe(path.join(dir, 'bin', 'node'));
  });

  it('rejects a bare name, which is a shell function, not a path', async () => {
    if (process.platform === 'win32') return;
    const { found } = await probeFakeShell('node');
    expect(found).toBeUndefined();
  });
});
