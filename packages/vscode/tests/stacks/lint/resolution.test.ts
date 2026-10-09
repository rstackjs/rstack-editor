import path from 'node:path';
import { afterEach, describe, expect, it } from '@rstest/core';
import {
  decideRslintMode,
  findAncestorRslintConfig,
  resolveRslint,
  RslintResolutionError,
} from '../../../src/stacks/lint/resolution';
import {
  installPackage,
  installShim,
  removeTemporaryDirectories,
  temporaryDirectory,
  writePackage,
} from './packageFixtures';

afterEach(removeTemporaryDirectories);

describe('resolveRslint', () => {
  it('resolves a native folder directly from its @rslint/core installation', () => {
    const root = temporaryDirectory();
    const coreDir = installPackage(root, '@rslint/core', '0.8.0');

    expect(resolveRslint({ folderRoot: root, mode: 'native' })).toEqual({
      mode: 'native',
      coreDir,
      coreVersion: '0.8.0',
    });
  });

  it('follows the rstack dependency chain for a bridged folder', () => {
    const root = temporaryDirectory();
    const rstackDir = installPackage(root, 'rstack', '0.6.1');
    const coreDir = installPackage(rstackDir, '@rslint/core', '0.8.0');
    const shimPath = installShim(rstackDir);

    expect(resolveRslint({ folderRoot: root, mode: 'bridged' })).toEqual({
      mode: 'bridged',
      coreDir,
      coreVersion: '0.8.0',
      rstackDir,
      rstackVersion: '0.6.1',
      shimPath,
    });
  });

  it.each(['custom-core', 'custom-core/package.json'])(
    'uses a relative corePath for the core hop in both modes (%s)',
    (corePath) => {
      const root = temporaryDirectory();
      const rstackDir = installPackage(root, 'rstack', '0.6.1');
      installShim(rstackDir);
      const customCore = writePackage(
        path.join(root, 'custom-core'),
        '@rslint/core',
        '0.8.1',
      );
      for (const mode of ['native', 'bridged'] as const) {
        const resolution = resolveRslint({
          folderRoot: root,
          mode,
          corePath,
        });
        expect(resolution.coreDir).toBe(customCore);
        expect(resolution.coreVersion).toBe('0.8.1');
      }
    },
  );

  it('reports an invalid configured path', () => {
    const corePath = 'missing-core';
    const root = temporaryDirectory();
    expect(() =>
      resolveRslint({ folderRoot: root, mode: 'native', corePath }),
    ).toThrow(
      `Could not access @rslint/core at ${path.join(root, 'missing-core')}`,
    );
    try {
      resolveRslint({ folderRoot: root, mode: 'native', corePath });
    } catch (error) {
      expect(error).toBeInstanceOf(RslintResolutionError);
      expect(error).toMatchObject({ code: 'invalid-package' });
    }
  });

  it('starts the native walk at the document directory, not the folder root', () => {
    // Per-document core resolution (rslint #1617): a file in a nested package
    // lints with that package's copy, exactly as `rs lint` run there would.
    const root = temporaryDirectory();
    installPackage(root, '@rslint/core', '0.8.0');
    const nested = path.join(root, 'packages', 'app');
    const nestedCore = installPackage(nested, '@rslint/core', '0.8.1');

    expect(
      resolveRslint({
        folderRoot: root,
        mode: 'native',
        documentDirectory: path.join(nested, 'src'),
      }),
    ).toEqual({ mode: 'native', coreDir: nestedCore, coreVersion: '0.8.1' });
  });

  it('ignores the document directory for a bridged folder', () => {
    // A bridged folder is one config choice for the whole folder, so it is
    // always exactly one core: rstack's own.
    const root = temporaryDirectory();
    const rstackDir = installPackage(root, 'rstack', '0.6.1');
    const coreDir = installPackage(rstackDir, '@rslint/core', '0.8.0');
    const shimPath = installShim(rstackDir);
    const nested = path.join(root, 'packages', 'app');
    installPackage(nested, '@rslint/core', '0.8.1');

    expect(
      resolveRslint({
        folderRoot: root,
        mode: 'bridged',
        documentDirectory: path.join(nested, 'src'),
      }),
    ).toEqual({
      mode: 'bridged',
      coreDir,
      coreVersion: '0.8.0',
      rstackDir,
      rstackVersion: '0.6.1',
      shimPath,
    });
  });

  it('reports a missing rstack shim before resolving its core', () => {
    const root = temporaryDirectory();
    installPackage(root, 'rstack', '0.6.1');

    expect(() => resolveRslint({ folderRoot: root, mode: 'bridged' })).toThrow(
      RslintResolutionError,
    );
    try {
      resolveRslint({ folderRoot: root, mode: 'bridged' });
    } catch (error) {
      expect(error).toMatchObject({ code: 'missing-shim' });
    }
  });
});

describe('findAncestorRslintConfig', () => {
  const root = path.parse(process.cwd()).root;
  const repo = path.join(root, 'repo');
  const app = path.join(repo, 'packages', 'app');
  const existing =
    (...files: string[]) =>
    (filePath: string): boolean =>
      files.includes(filePath);

  it('finds a config in an ancestor directory', () => {
    const config = path.join(repo, 'rslint.config.ts');
    expect(findAncestorRslintConfig(app, existing(config))).toBe(config);
  });

  it('prefers the nearest ancestor', () => {
    const nearer = path.join(repo, 'packages', 'rslint.config.mjs');
    const farther = path.join(repo, 'rslint.config.js');
    expect(findAncestorRslintConfig(app, existing(farther, nearer))).toBe(
      nearer,
    );
  });

  it('takes the names in upstream order within one directory', () => {
    const js = path.join(repo, 'rslint.config.js');
    const ts = path.join(repo, 'rslint.config.ts');
    expect(findAncestorRslintConfig(app, existing(ts, js))).toBe(js);
  });

  it('never looks inside the folder itself', () => {
    const own = path.join(app, 'rslint.config.js');
    expect(findAncestorRslintConfig(app, existing(own))).toBeUndefined();
  });

  it('skips ancestors under node_modules', () => {
    const vendored = path.join(repo, 'node_modules', 'pkg');
    const inside = path.join(repo, 'node_modules', 'rslint.config.js');
    const above = path.join(repo, 'rslint.config.js');
    expect(
      findAncestorRslintConfig(path.join(vendored, 'src'), existing(inside)),
    ).toBeUndefined();
    expect(
      findAncestorRslintConfig(
        path.join(vendored, 'src'),
        existing(inside, above),
      ),
    ).toBe(above);
  });

  it('reaches the filesystem root and stops there', () => {
    const atRoot = path.join(root, 'rslint.config.mts');
    expect(findAncestorRslintConfig(app, existing(atRoot))).toBe(atRoot);
    expect(findAncestorRslintConfig(root, existing(atRoot))).toBeUndefined();
  });
});

describe('decideRslintMode', () => {
  it('ranks an ancestor config below in-folder configs and a root Rstack config', () => {
    const ancestorConfigPath = '/repo/rslint.config.js';
    expect(
      decideRslintMode({
        nativeConfigPaths: ['/repo/app/rslint.config.js'],
        rootRstackConfigPath: '/repo/app/rstack.config.ts',
        ancestorConfigPath,
      }),
    ).toBe('native');
    expect(
      decideRslintMode({
        nativeConfigPaths: [],
        rootRstackConfigPath: '/repo/app/rstack.config.ts',
        ancestorConfigPath,
      }),
    ).toBe('bridged');
    expect(
      decideRslintMode({ nativeConfigPaths: [], ancestorConfigPath }),
    ).toBe('native');
    expect(decideRslintMode({ nativeConfigPaths: [] })).toBeUndefined();
  });
});
