import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from '@rstest/core';
import {
  decideDocumentMode,
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
  it('resolves a native runtime directly from its @rslint/core installation', () => {
    const root = temporaryDirectory();
    const coreDir = installPackage(root, '@rslint/core', '0.8.0');

    expect(resolveRslint({ folderRoot: root, mode: 'native' })).toEqual({
      mode: 'native',
      coreDir,
      coreVersion: '0.8.0',
    });
  });

  it('follows the rstack dependency chain for a bridged runtime', () => {
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

  it('ignores the document directory for a bridged runtime', () => {
    // Every bridged document of a folder evaluates the one root Rstack config,
    // so it is always exactly one core: rstack's own.
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
  const writeConfig = (directory: string, name: string): string => {
    fs.mkdirSync(directory, { recursive: true });
    const configPath = path.join(directory, name);
    fs.writeFileSync(configPath, 'export default [];');
    return configPath;
  };

  it('takes the nearest config above the folder', () => {
    const repo = temporaryDirectory();
    installPackage(repo, '@rslint/core', '0.9.4');
    writeConfig(repo, 'rslint.config.ts');
    const nearer = writeConfig(
      path.join(repo, 'packages'),
      'rslint.config.mjs',
    );
    const app = path.join(repo, 'packages', 'app');
    fs.mkdirSync(app, { recursive: true });

    expect(findAncestorRslintConfig(app)).toBe(nearer);
  });

  it('ignores the config while @rslint/core does not resolve', () => {
    const home = temporaryDirectory();
    writeConfig(home, 'rslint.config.js');
    const project = path.join(home, 'project');
    fs.mkdirSync(project, { recursive: true });

    expect(findAncestorRslintConfig(project)).toBeUndefined();
  });

  it('skips configs under node_modules', () => {
    const repo = temporaryDirectory();
    installPackage(repo, '@rslint/core', '0.9.4');
    writeConfig(path.join(repo, 'node_modules'), 'rslint.config.js');
    const vendored = path.join(repo, 'node_modules', 'pkg');
    fs.mkdirSync(vendored, { recursive: true });
    expect(findAncestorRslintConfig(vendored)).toBeUndefined();

    const above = writeConfig(repo, 'rslint.config.js');
    expect(findAncestorRslintConfig(vendored)).toBe(above);
  });
});

describe('decideDocumentMode', () => {
  const folderRoot = '/workspace';
  const rootRstackConfigPath = '/workspace/rstack.config.ts';
  const legacyConfig = '/workspace/packages/legacy/rslint.config.ts';
  const ancestorConfigPath = '/rslint.config.mjs';

  it.each([
    {
      name: 'a nested native config owns the documents under it',
      documentPath: '/workspace/packages/legacy/src/index.ts',
      nativeConfigPaths: [legacyConfig],
      rootRstackConfigPath,
      expected: 'native',
    },
    {
      name: 'the root Rstack config owns the documents outside it',
      documentPath: '/workspace/src/index.ts',
      nativeConfigPaths: [legacyConfig],
      rootRstackConfigPath,
      expected: 'bridged',
    },
    {
      name: 'a root native config beside a root Rstack config wins everywhere',
      documentPath: '/workspace/packages/app/src/index.ts',
      nativeConfigPaths: ['/workspace/rslint.config.mjs', legacyConfig],
      rootRstackConfigPath,
      expected: 'native',
    },
    {
      name: 'a sibling native config does not count',
      documentPath: '/workspace/packages/app/src/index.ts',
      nativeConfigPaths: [legacyConfig],
      expected: undefined,
    },
    {
      name: 'no config leaves the document unserved',
      documentPath: '/workspace/src/index.ts',
      nativeConfigPaths: [],
      expected: undefined,
    },
    {
      name: 'a config above the folder owns an otherwise ungoverned document',
      documentPath: '/workspace/src/index.ts',
      nativeConfigPaths: [legacyConfig],
      ancestorConfigPath,
      expected: 'native',
    },
    {
      name: 'a root Rstack config precedes a config above the folder',
      documentPath: '/workspace/src/index.ts',
      nativeConfigPaths: [],
      rootRstackConfigPath,
      ancestorConfigPath,
      expected: 'bridged',
    },
  ])('$name', ({ name: _name, expected, ...signals }) => {
    expect(
      decideDocumentMode({ folderRoot, platform: 'linux', ...signals }),
    ).toBe(expected);
  });

  it('compares Windows paths case-insensitively', () => {
    const signals = {
      folderRoot: 'C:\\Work\\Repo',
      nativeConfigPaths: ['c:\\work\\repo\\packages\\Legacy\\rslint.config.ts'],
      rootRstackConfigPath: 'C:\\Work\\Repo\\rstack.config.ts',
      platform: 'win32' as const,
    };
    expect(
      decideDocumentMode({
        ...signals,
        documentPath: 'C:\\WORK\\REPO\\Packages\\legacy\\src\\index.ts',
      }),
    ).toBe('native');
    expect(
      decideDocumentMode({
        ...signals,
        documentPath: 'c:\\work\\repo\\src\\index.ts',
      }),
    ).toBe('bridged');
  });
});
