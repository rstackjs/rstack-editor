import { describe, expect, it } from '@rstest/core';
import {
  NotInstalledEpisode,
  formatConfigDependencyMissingLog,
  formatConfigDependencyMissingStatus,
  formatNotInstalledLog,
  formatNotInstalledStatus,
} from '../../src/shared/notInstalled';

// One wording for the three stacks: the restart hint names the stack's own
// command exactly as the Command Palette shows it (`category: title` in
// package.json), so the user can type what the status says.
describe('not-installed wording', () => {
  it('names each stack’s restart command in the status reason', () => {
    expect(formatNotInstalledStatus('fmt', 'rstack')).toBe(
      'rstack is not installed (node_modules missing) — install it, then run "Rstack: Restart rs fmt" if this status stays',
    );
    expect(formatNotInstalledStatus('rslint', 'rstack')).toContain(
      '"Rstack: Restart Rslint"',
    );
    expect(formatNotInstalledStatus('rstest', '@rstest/core')).toBe(
      '@rstest/core is not installed (node_modules missing) — install it, then run "Rstack: Restart Rstest" if this status stays',
    );
  });

  it('names the config and the same way out for a missing config import', () => {
    expect(
      formatConfigDependencyMissingStatus(
        'rstest',
        'templates/app/rstack.config.ts',
      ),
    ).toBe(
      'templates/app/rstack.config.ts imports a package that is not installed — install the project dependencies, then run "Rstack: Restart Rstest" if this status stays',
    );
  });

  it('logs where the stack looked', () => {
    expect(formatNotInstalledLog('rstack', 'app', '/repo/app')).toBe(
      'rstack is not installed in app (node_modules missing); searched from /repo/app',
    );
  });

  it("logs the config, the loader's own words and the way out", () => {
    expect(
      formatConfigDependencyMissingLog(
        'rstest',
        '/repo/templates/app/rstack.config.ts',
        "Cannot find package '@rsbuild/plugin-react' imported from /repo/templates/app/rstack.config.ts",
      ),
    ).toBe(
      "Cannot load /repo/templates/app/rstack.config.ts: Cannot find package '@rsbuild/plugin-react' imported from /repo/templates/app/rstack.config.ts. Install the project dependencies to enable Rstest for this config.",
    );
  });
});

describe('NotInstalledEpisode', () => {
  it('warns once until success clears the episode', () => {
    const episode = new NotInstalledEpisode();
    const first = episode.observe(
      'fmt',
      'rstack.config.ts',
      "Cannot find package 'missing'",
    );
    expect(first.warning).toContain("Cannot find package 'missing'");
    expect(episode.active).toBe(true);

    expect(
      episode.observe(
        'fmt',
        'rstack.config.ts',
        "Cannot find package 'missing'",
      ).warning,
    ).toBe(undefined);

    expect(episode.clear()).toBe(true);
    expect(episode.active).toBe(false);
    expect(
      episode.observe(
        'fmt',
        'rstack.config.ts',
        "Cannot find package 'missing'",
      ).warning,
    ).toContain("Cannot find package 'missing'");
  });

  it('starts a new warning when the missing dependency changes', () => {
    const episode = new NotInstalledEpisode();
    episode.observe('rslint', 'rslint.config.ts', "Cannot find package 'a'");
    expect(
      episode.observe('rslint', 'rslint.config.ts', "Cannot find package 'b'")
        .warning,
    ).toContain("Cannot find package 'b'");
  });

  it('deduplicates package warnings by package and search directory until cleared', () => {
    const episode = new NotInstalledEpisode();
    expect(episode.observePackage('rstack', 'app', '/app')).toBe(
      formatNotInstalledLog('rstack', 'app', '/app'),
    );
    expect(episode.observePackage('rstack', 'app', '/app')).toBeUndefined();
    expect(episode.observePackage('rstack', 'app', '/other')).toBeDefined();
    expect(
      episode.observePackage('@rstest/core', 'app', '/other'),
    ).toBeDefined();
    episode.clear();
    expect(
      episode.observePackage('@rstest/core', 'app', '/other'),
    ).toBeDefined();
  });
});
