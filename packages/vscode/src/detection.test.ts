import { describe, expect, it, rs } from '@rstest/core';
import type vscode from 'vscode';
import type { DetectionSnapshot } from './types';

// `detection.ts` imports the `vscode` namespace for the watcher/`findFiles`
// paths. `detectionWatchPatterns` is pure, but the module still has to load, so
// the namespace is stubbed away: unit tests run in plain Node, with no
// extension host (unit tests are Rstest, E2E is Electron). The stub carries
// exactly what `DetectionService` touches with no workspace folder open — its
// event plumbing — so the notification rules can be exercised here too.
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
  const vscode = {
    EventEmitter,
    workspace: {
      // No folder is open: every pass produces the empty snapshot, so the
      // detection signature is unchanged by construction.
      workspaceFolders: undefined,
      onDidChangeWorkspaceFolders: () => disposable,
      onDidChangeConfiguration: () => disposable,
    },
  };
  return { ...vscode, default: vscode };
});

import {
  DEFAULT_RSTEST_CONFIG_GLOBS,
  DETECTION_WATCH_NAMES,
  DetectionService,
  detectionWatchPatterns,
} from './detection';

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
