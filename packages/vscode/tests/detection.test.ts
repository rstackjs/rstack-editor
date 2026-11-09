import { describe, expect, it, rs } from '@rstest/core';
import vscode from 'vscode';
import type { DetectionSnapshot } from '../src/types';

// `detection.ts` imports the `vscode` namespace for the watcher/`findFiles`
// paths. `detectionWatchPatterns` is pure, but the module still has to load, so
// the namespace is stubbed away: unit tests run in plain Node, with no
// extension host (unit tests are Rstest, E2E is Electron). The stub carries
// exactly what `DetectionService` touches — with no workspace folder open its
// event plumbing, and the single-fake-folder surface the watcher-event-counter
// test needs (fake watchers are captured on `workspace.watchers`, disposal
// removes them like a real dispose does, and folder-set listeners are
// captured).
rs.mock('vscode', () => {
  class EventEmitter {
    readonly #listeners = new Set<(value: unknown) => void>();
    readonly event = (listener: (value: unknown) => void) => {
      this.#listeners.add(listener);
      return {
        dispose: () => {
          this.#listeners.delete(listener);
        },
      };
    };
    fire(value: unknown): void {
      for (const listener of [...this.#listeners]) {
        listener(value);
      }
    }
    dispose(): void {
      this.#listeners.clear();
    }
  }
  const disposable = { dispose: () => undefined };

  type FakeHandler = (uri: unknown) => void;
  type FakeWatcher = {
    dispose(): void;
    fire(
      kind: 'onDidCreate' | 'onDidChange' | 'onDidDelete',
      uri: unknown,
    ): void;
  };
  const watchers: FakeWatcher[] = [];
  const folderChangeCbs: (() => void)[] = [];
  const makeWatcher = (): FakeWatcher => {
    const handlers: Record<
      'onDidCreate' | 'onDidChange' | 'onDidDelete',
      FakeHandler[]
    > = {
      onDidCreate: [],
      onDidChange: [],
      onDidDelete: [],
    };
    const watcher = {
      onDidCreate: (cb: FakeHandler) => {
        handlers.onDidCreate.push(cb);
        return disposable;
      },
      onDidChange: (cb: FakeHandler) => {
        handlers.onDidChange.push(cb);
        return disposable;
      },
      onDidDelete: (cb: FakeHandler) => {
        handlers.onDidDelete.push(cb);
        return disposable;
      },
      dispose: () => {
        const index = watchers.indexOf(watcher);
        if (index >= 0) {
          watchers.splice(index, 1);
        }
      },
      fire: (
        kind: 'onDidCreate' | 'onDidChange' | 'onDidDelete',
        uri: unknown,
      ) => {
        for (const cb of handlers[kind]) {
          cb(uri);
        }
      },
    };
    watchers.push(watcher);
    return watcher;
  };
  class RelativePattern {
    constructor(
      readonly base: unknown,
      readonly pattern: string,
    ) {}
  }
  // Enough of `vscode.Uri` for `RelativePattern` bases in `installWatchers`.
  class Uri {
    readonly scheme = 'file';
    constructor(readonly fsPath: string) {}
    get path(): string {
      return this.fsPath;
    }
    toString(): string {
      return `file://${this.fsPath}`;
    }
    static file(path: string): Uri {
      return new Uri(path);
    }
    static joinPath(base: Uri, ...segments: string[]): Uri {
      return new Uri([base.fsPath, ...segments].join('/'));
    }
  }
  const vscode = {
    EventEmitter,
    RelativePattern,
    Uri,
    workspace: {
      // No folder is open: every pass produces the empty snapshot, so the
      // detection signature is unchanged by construction.
      workspaceFolders: undefined,
      watchers,
      folderChangeCbs,
      onDidChangeWorkspaceFolders: (cb: () => void) => {
        folderChangeCbs.push(cb);
        return disposable;
      },
      onDidChangeConfiguration: () => disposable,
      // One watcher per (re)install pattern; any listener fires its event.
      createFileSystemWatcher: () => makeWatcher(),
      // `detectFolder` scans: empty on every glob, so the snapshot can only
      // report "nothing detected" for the fake folder.
      findFiles: () => Promise.resolve([]),
      getConfiguration: () => ({ get: () => undefined }),
      fs: {
        stat: () =>
          Promise.reject(new Error('the unit stub has no filesystem')),
      },
    },
  };
  return { ...vscode, default: vscode };
});

import {
  DEFAULT_RSTEST_CONFIG_GLOBS,
  DETECTION_WATCH_NAMES,
  DetectionService,
  detectionWatchPatterns,
} from '../src/detection';

/**
 * VS Code's glob engine has no nested brace groups. `splitGlobAware`
 * (`src/vs/base/common/glob.ts`) tracks `inBraces` as a **boolean**, so a `{`
 * inside an already open group does not nest: the first `}` closes the group
 * and the pattern is split on the next separator, mid-group. `parseRegExp` then
 * compiles the fragments into a regex that matches nothing at all.
 *
 * Concatenating the fixed name list with the Rstest globs into one pattern
 * produced exactly that shape and silently disabled the whole re-detection
 * watcher, so the invariant is asserted here rather than left to review.
 */
const hasNestedBraces = (pattern: string): boolean => {
  let depth = 0;
  for (const char of pattern) {
    if (char === '{') {
      depth += 1;
      if (depth > 1) {
        return true;
      }
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return false;
};

/** Expands the one brace level VS Code's glob engine actually supports. */
const expandBraces = (pattern: string): string[] => {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) {
    return [pattern];
  }
  const [group, body] = match;
  return body
    .split(',')
    .map(
      (alternative) =>
        pattern.slice(0, match.index) +
        alternative +
        pattern.slice(match.index + group.length),
    );
};

const globMatches = (pattern: string, relativePath: string): boolean =>
  expandBraces(pattern).some((expanded) => {
    const source = expanded
      .split('**/')
      .map((segment) =>
        segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
      )
      .join('(?:.*/)?');
    return new RegExp(`^${source}$`).test(relativePath);
  });

/** Every file kind the shell's detection watcher must react to. */
const WATCHED_CANDIDATES = [
  'rslint.config.ts',
  'rslint.config.mjs',
  'packages/a/rslint.config.js',
  'rstack.config.ts',
  'packages/a/rstack.config.mts',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'packages/a/pnpm-lock.yaml',
  'rstest.config.mts',
  'sub/rstest.config.mjs',
];

describe('hasNestedBraces', () => {
  it('flags the single-concatenated-glob shape', () => {
    expect(
      hasNestedBraces(
        '{**/{rslint.config.ts,yarn.lock},**/rstest.config.{mjs,ts}}',
      ),
    ).toBe(true);
  });

  it('accepts a single-level group', () => {
    expect(hasNestedBraces('**/{rslint.config.ts,yarn.lock}')).toBe(false);
  });
});

describe('detectionWatchPatterns', () => {
  it('emits no pattern with a nested brace group', () => {
    for (const rstestGlobs of [
      [...DEFAULT_RSTEST_CONFIG_GLOBS],
      ['**/rstest.config.{mjs,ts,js,cjs,mts,cts}', 'apps/*/rstest.config.ts'],
      [],
    ]) {
      for (const pattern of detectionWatchPatterns(rstestGlobs)) {
        expect(hasNestedBraces(pattern)).toBe(false);
      }
    }
  });

  it('keeps the fixed name list and the Rstest globs as separate patterns', () => {
    const patterns = detectionWatchPatterns([
      '**/rstest.config.{mjs,ts}',
      'apps/*/rstest.config.ts',
    ]);
    expect(patterns).toEqual([
      `**/{${DETECTION_WATCH_NAMES.join(',')}}`,
      '**/rstest.config.{mjs,ts}',
      'apps/*/rstest.config.ts',
    ]);
  });

  it('covers the Rslint config names, `rstack.config.*` and the lockfiles', () => {
    const fixed = detectionWatchPatterns([])[0]!;
    for (const name of DETECTION_WATCH_NAMES) {
      expect(fixed).toContain(name);
    }
  });

  it('de-duplicates repeated Rstest globs', () => {
    const patterns = detectionWatchPatterns([
      '**/rstest.config.ts',
      '**/rstest.config.ts',
    ]);
    expect(patterns).toHaveLength(2);
  });

  it('matches every detection-relevant file through at least one pattern', () => {
    const patterns = detectionWatchPatterns([...DEFAULT_RSTEST_CONFIG_GLOBS]);
    for (const candidate of WATCHED_CANDIDATES) {
      expect(patterns.some((pattern) => globMatches(pattern, candidate))).toBe(
        true,
      );
    }
  });

  it('does not match unrelated files', () => {
    const patterns = detectionWatchPatterns([...DEFAULT_RSTEST_CONFIG_GLOBS]);
    for (const candidate of [
      'src/index.ts',
      'rslint.json',
      'rstack.config.json',
    ]) {
      expect(patterns.some((pattern) => globMatches(pattern, candidate))).toBe(
        false,
      );
    }
  });
});

/**
 * With no workspace folder open every pass yields the empty snapshot, so the
 * detection signature is identical across passes by construction — exactly the
 * shape a lockfile write or a `rstack.restart` produces in a real workspace
 * whose `node_modules` was replaced without touching a watched file.
 */
describe('DetectionService — notification rules', () => {
  const fakeOutput = () =>
    ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }) as unknown as vscode.LogOutputChannel;

  const listen = (service: DetectionService) => {
    const seen: DetectionSnapshot[] = [];
    service.onDidChange((snapshot) => seen.push(snapshot));
    return seen;
  };

  it('stays quiet when the signature did not change', async () => {
    const service = new DetectionService(fakeOutput());
    const seen = listen(service);
    await service.initialize();
    await service.refresh();
    expect(seen).toHaveLength(0);
    service.dispose();
  });

  it('does not notify after disposal', async () => {
    const service = new DetectionService(fakeOutput());
    const seen = listen(service);
    await service.initialize();
    service.dispose();
    await service.refresh();
    expect(seen).toHaveLength(0);
  });
});

/**
 * The E2E arm probe (`e2e/rstest/suite/helpers.ts`) waits for this counter to
 * move before mutating watched fixture files, because the FileSystemWatcher
 * API has no "watcher armed" signal and the Linux backends swallow an event
 * burst issued inside the arm window. What the suites rely on is asserted
 * here: events reach the counter only through the live watcher set, and every
 * reinstall restarts the count at zero.
 */
describe('DetectionService — watcher event counter', () => {
  type FakeWatcher = {
    dispose(): void;
    fire(kind: string, uri: unknown): void;
  };

  const workspaceStub = () =>
    (
      vscode as unknown as {
        workspace: {
          workspaceFolders: unknown;
          watchers: FakeWatcher[];
          folderChangeCbs: (() => void)[];
        };
      }
    ).workspace;

  const fakeOutput = () =>
    ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }) as unknown as vscode.LogOutputChannel;

  it('counts events on the live watcher set and restarts on each install', async () => {
    const stub = workspaceStub();
    stub.folderChangeCbs.length = 0;
    stub.workspaceFolders = [
      {
        uri: {
          scheme: 'file',
          fsPath: '/tmp/rstack-detection-unit/folder',
          toString: () => 'file:///tmp/rstack-detection-unit/folder',
        },
        name: 'folder',
        index: 0,
      },
    ];
    const service = new DetectionService(fakeOutput());
    await service.initialize();
    expect(service.watcherEventCount).toBe(0);
    expect(stub.watchers.length).toBeGreaterThan(0);

    // One event through every installed watcher: the counter is per event
    // received, not per distinct path (the E2E probe only needs movement).
    const eventUri = {
      path: '/tmp/rstack-detection-unit/folder/rstest.config.ts',
    };
    const fireEverywhere = () => {
      for (const watcher of stub.watchers) {
        watcher.fire('onDidChange', eventUri);
      }
    };
    fireEverywhere();
    expect(service.watcherEventCount).toBe(stub.watchers.length);

    // The folder-set change reinstall: old watchers dispose (removing them
    // from the stub) and the count restarts — a stale count from the previous
    // set must never satisfy a wait for the new one.
    for (const cb of stub.folderChangeCbs) {
      cb();
    }
    expect(service.watcherEventCount).toBe(0);
    expect(stub.watchers.length).toBeGreaterThan(0);
    fireEverywhere();
    expect(service.watcherEventCount).toBe(stub.watchers.length);

    service.dispose();
    stub.workspaceFolders = undefined;
  });
});
