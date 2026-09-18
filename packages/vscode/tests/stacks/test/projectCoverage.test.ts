import path from 'node:path';
import { describe, expect, it, rs } from '@rstest/core';
import {
  type ChildProjectRef,
  computeCoveredConfigs,
  computeFileOwnership,
} from '../../../src/stacks/test/projectCoverage';

// Paths are absolute in practice; use POSIX-looking paths for readability.
// `include` defaults to a shared pattern so identity/footprint coverage is
// exercised without the include guard getting in the way; pass a distinct one
// to exercise the guard itself.
const DEFAULT_INCLUDE = ['**/*.test.ts'];
// The caller-side key is the config file path itself for readability (in the
// extension it is a URI string).
const p = (
  configFilePath: string,
  root: string,
  childProjects: ChildProjectRef[] = [],
  include: string[] = DEFAULT_INCLUDE,
) => ({ key: configFilePath, configFilePath, root, childProjects, include });
// A file-based child project (has its own config file).
const file = (configFilePath: string): ChildProjectRef => ({
  configFilePath,
  root: null,
});
// An inline child project (no config file of its own).
const inline = (root: string): ChildProjectRef => ({
  configFilePath: null,
  root,
});

const owner = (
  key: string,
  root: string,
  include: string[] = ['**/*.test.ts'],
  exclude: string[] = [],
) => ({ key, root, include, exclude });

describe('computeFileOwnership', () => {
  it('preserves glob case on win32 while containing a lowercase-drive file', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const separator = Object.getOwnPropertyDescriptor(path, 'sep')!;
    const mocks = [
      rs.spyOn(path, 'normalize').mockImplementation(path.win32.normalize),
      rs.spyOn(path, 'parse').mockImplementation(path.win32.parse),
      rs.spyOn(path, 'relative').mockImplementation(path.win32.relative),
      rs.spyOn(path, 'isAbsolute').mockImplementation(path.win32.isAbsolute),
    ];
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(path, 'sep', { value: '\\' });
    // Picomatch checks navigator before process on Node versions exposing it.
    rs.stubGlobal('navigator', { platform: 'Win32' });
    try {
      const owns = computeFileOwnership([
        owner('root', 'C:\\Repo'),
        owner(
          'nested',
          'C:\\Repo\\Package',
          ['Tests/**/*.test.ts'],
          ['Tests/Excluded/**'],
        ),
      ]);
      const file = 'c:\\Repo\\Package\\Tests\\a.test.ts';
      expect(owns('nested', file)).toBe(true);
      expect(owns('root', file)).toBe(false);
      expect(owns('nested', 'c:\\Repo\\Package\\tests\\a.test.ts')).toBe(false);
      expect(
        owns('nested', 'c:\\Repo\\Package\\Tests\\Excluded\\a.test.ts'),
      ).toBe(false);
      expect(
        owns('root', 'c:\\Repo\\Package\\Tests\\Excluded\\a.test.ts'),
      ).toBe(true);
    } finally {
      mocks.forEach((mock) => mock.mockRestore());
      Object.defineProperty(process, 'platform', platform);
      Object.defineProperty(path, 'sep', separator);
      rs.unstubAllGlobals();
    }
  });

  it('assigns a file to the deepest matching root', () => {
    const owns = computeFileOwnership([
      owner('root', '/repo'),
      owner('package', '/repo/packages/a'),
    ]);

    expect(owns('root', '/repo/packages/a/src/a.test.ts')).toBe(false);
    expect(owns('package', '/repo/packages/a/src/a.test.ts')).toBe(true);
    expect(owns('root', '/repo/packages/ab/a.test.ts')).toBe(true);
    expect(owns('package', '/repo/packages/ab/a.test.ts')).toBe(false);
  });

  it('retains all matching projects with equal roots', () => {
    const owns = computeFileOwnership([
      owner('unit', '/repo'),
      owner('integration', '/repo'),
    ]);

    expect(owns('unit', '/repo/a.test.ts')).toBe(true);
    expect(owns('integration', '/repo/a.test.ts')).toBe(true);
  });

  it('normalizes roots and trailing separators, including the filesystem root', () => {
    const owns = computeFileOwnership([
      owner('filesystem', '/'),
      owner('repo', '/repo/./packages/'),
    ]);

    expect(owns('filesystem', '/repo/packages/a.test.ts')).toBe(false);
    expect(owns('repo', '/repo/packages/a.test.ts')).toBe(true);
    expect(owns('repo', '/elsewhere/a.test.ts')).toBe(false);
  });

  it('matches hidden files with dot enabled', () => {
    const owns = computeFileOwnership([
      owner('repo', '/repo'),
      owner('nested', '/repo/.hidden'),
    ]);
    expect(owns('repo', '/repo/.hidden/.a.test.ts')).toBe(false);
    expect(owns('nested', '/repo/.hidden/.a.test.ts')).toBe(true);
  });

  it('ignores projects with unresolved empty includes', () => {
    const owns = computeFileOwnership([
      owner('unresolved', '/repo/deep', []),
      owner('root', '/repo'),
    ]);
    expect(owns('root', '/repo/deep/a.test.ts')).toBe(true);
    expect(owns('unresolved', '/repo/deep/a.test.ts')).toBe(false);
  });

  it('leaves a shallow owner when a deeper project narrows the file out', () => {
    const owns = computeFileOwnership([
      owner('root', '/repo'),
      owner('deep', '/repo/deep', ['src/**/*.test.ts'], ['src/excluded/**']),
    ]);

    expect(owns('root', '/repo/deep/other/a.test.ts')).toBe(true);
    expect(owns('root', '/repo/deep/src/excluded/a.test.ts')).toBe(true);
    expect(owns('deep', '/repo/deep/other/a.test.ts')).toBe(false);
    expect(owns('deep', '/repo/deep/src/excluded/a.test.ts')).toBe(false);
    expect(owns('deep', '/repo/deep/src/a.test.ts')).toBe(true);
  });

  it('allows every project when nobody claims the file', () => {
    const owns = computeFileOwnership([
      owner('repo', '/repo'),
      owner('lookalike', '/repo-name'),
    ]);

    expect(owns('repo', '/repo-name/file.ts')).toBe(true);
  });
});

describe('computeCoveredConfigs', () => {
  it('suppresses child configs aggregated by a root config', () => {
    // Mirrors rslib: a root config aggregates packages/* and tests, while each
    // package also has its own standalone config.
    const covered = computeCoveredConfigs([
      p('/repo/rstest.config.ts', '/repo', [
        file('/repo/packages/core/rstest.config.ts'),
        file('/repo/packages/dts/rstest.config.ts'),
        file('/repo/tests/rstest.config.ts'),
      ]),
      p('/repo/tests/rstest.config.ts', '/repo/tests', [inline('/repo/tests')]),
      p('/repo/packages/core/rstest.config.ts', '/repo/packages/core'),
      p('/repo/packages/dts/rstest.config.ts', '/repo/packages/dts'),
    ]);

    // Only the aggregator root survives.
    expect([...covered].sort()).toEqual([
      '/repo/packages/core/rstest.config.ts',
      '/repo/packages/dts/rstest.config.ts',
      '/repo/tests/rstest.config.ts',
    ]);
  });

  it('keeps independent per-package configs when there is no aggregator', () => {
    const covered = computeCoveredConfigs([
      p('/repo/packages/a/rstest.config.ts', '/repo/packages/a'),
      p('/repo/packages/b/rstest.config.ts', '/repo/packages/b'),
    ]);
    expect(covered.size).toBe(0);
  });

  it('does not suppress a lone aggregator of inline children', () => {
    // A lone aggregator whose inline children share its own root must not hide
    // itself.
    const covered = computeCoveredConfigs([
      p('/repo/tests/rstest.config.ts', '/repo/tests', [
        inline('/repo/tests'),
        inline('/repo/tests'),
      ]),
    ]);
    expect(covered.size).toBe(0);
  });

  it('suppresses exactly the aggregated config when a directory has several', () => {
    // `apps/web` has two standalone configs (e.g. different include/exclude),
    // and the root aggregates only one of them by file. Only that file is
    // covered; the other config keeps its own tests visible.
    const covered = computeCoveredConfigs([
      p('/repo/rstest.config.ts', '/repo', [
        file('/repo/apps/web/rstest.config.ts'),
      ]),
      p('/repo/apps/web/rstest.config.ts', '/repo/apps/web'),
      p('/repo/apps/web/rstest.e2e.config.ts', '/repo/apps/web'),
    ]);
    expect([...covered]).toEqual(['/repo/apps/web/rstest.config.ts']);
  });

  it('suppresses a nested intermediate config the root also aggregates', () => {
    // A root aggregates `sub` (which itself has `projects`) plus another
    // project. `initCli` flattens `sub` to its leaf projects, so `sub`'s own
    // config file never appears in the root's child list — but its leaves do.
    const covered = computeCoveredConfigs([
      p('/repo/rstest.config.ts', '/repo', [
        file('/repo/sub/a/rstest.config.ts'),
        file('/repo/sub/b/rstest.config.ts'),
        file('/repo/other/rstest.config.ts'),
      ]),
      p('/repo/sub/rstest.config.ts', '/repo/sub', [
        file('/repo/sub/a/rstest.config.ts'),
        file('/repo/sub/b/rstest.config.ts'),
      ]),
    ]);
    expect([...covered]).toEqual(['/repo/sub/rstest.config.ts']);
  });

  it('suppresses a nested config even when the root aggregates only it', () => {
    // The root aggregates a single nested child with inline leaves, so both
    // flatten to the same footprint. The outer (ancestor-root) config wins.
    const covered = computeCoveredConfigs([
      p('/repo/rstest.config.ts', '/repo', [
        inline('/repo/sub/a'),
        inline('/repo/sub/b'),
      ]),
      p('/repo/sub/rstest.config.ts', '/repo/sub', [
        inline('/repo/sub/a'),
        inline('/repo/sub/b'),
      ]),
    ]);
    expect([...covered]).toEqual(['/repo/sub/rstest.config.ts']);
  });

  it('never lets two unrelated configs with identical footprints hide each other', () => {
    const covered = computeCoveredConfigs([
      p('/repo/a/rstest.config.ts', '/repo/a', [
        file('/shared/1/rstest.config.ts'),
      ]),
      p('/repo/b/rstest.config.ts', '/repo/b', [
        file('/shared/1/rstest.config.ts'),
      ]),
    ]);
    expect(covered.size).toBe(0);
  });

  it('keeps a child config whose include the parent does not match', () => {
    // The root aggregates `e2e`, but the child matches only `**/*.e2e.ts`,
    // which the root's own include does not glob (AST mode). Suppressing it
    // would hide those tests, so the child stays visible.
    const covered = computeCoveredConfigs([
      p('/repo/rstest.config.ts', '/repo', [
        file('/repo/e2e/rstest.config.ts'),
      ]),
      p('/repo/e2e/rstest.config.ts', '/repo/e2e', [], ['**/*.e2e.ts']),
    ]);
    expect(covered.size).toBe(0);
  });

  it('suppresses a child whose include is a subset of the parent include', () => {
    const covered = computeCoveredConfigs([
      p(
        '/repo/rstest.config.ts',
        '/repo',
        [file('/repo/pkg/rstest.config.ts')],
        ['**/*.test.ts', '**/*.spec.ts'],
      ),
      p('/repo/pkg/rstest.config.ts', '/repo/pkg', [], ['**/*.test.ts']),
    ]);
    expect([...covered]).toEqual(['/repo/pkg/rstest.config.ts']);
  });

  it('normalizes reported paths before matching', () => {
    const covered = computeCoveredConfigs([
      p('/repo/rstest.config.ts', '/repo', [
        // Child config file reported with a redundant segment.
        file('/repo/packages/./core/rstest.config.ts'),
        // Flattened inline leaf reported with a trailing separator.
        inline('/repo/sub/a/'),
      ]),
      p('/repo/packages/core/rstest.config.ts', '/repo/packages/core'),
      p('/repo/sub/rstest.config.ts', '/repo/sub', [inline('/repo/sub/a')]),
    ]);
    expect([...covered].sort()).toEqual([
      '/repo/packages/core/rstest.config.ts',
      '/repo/sub/rstest.config.ts',
    ]);
  });
});
