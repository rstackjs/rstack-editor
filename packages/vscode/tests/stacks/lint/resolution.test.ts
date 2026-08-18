import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from '@rstest/core';
import {
  resolveRslint,
  RslintResolutionError,
} from '../../../src/stacks/lint/resolution';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rslint-resolution-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function writePackage(
  directory: string,
  name: 'rstack' | '@rslint/core',
  version: string,
): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, version }),
  );
}

function installPackage(
  root: string,
  name: 'rstack' | '@rslint/core',
  version: string,
): string {
  const directory = path.join(root, 'node_modules', ...name.split('/'));
  writePackage(directory, name, version);
  return fs.realpathSync(directory);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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
    const shimPath = path.join(rstackDir, 'dist', 'rslintConfig.js');
    fs.mkdirSync(path.dirname(shimPath));
    fs.writeFileSync(shimPath, 'export default [];');

    expect(resolveRslint({ folderRoot: root, mode: 'bridged' })).toEqual({
      mode: 'bridged',
      coreDir,
      coreVersion: '0.8.0',
      rstackDir,
      rstackVersion: '0.6.1',
      shimPath,
    });
  });

  it('uses corePath for the core hop in both modes', () => {
    const root = temporaryDirectory();
    const rstackDir = installPackage(root, 'rstack', '0.6.1');
    const shimPath = path.join(rstackDir, 'dist', 'rslintConfig.js');
    fs.mkdirSync(path.dirname(shimPath));
    fs.writeFileSync(shimPath, 'export default [];');
    const customCorePath = path.join(root, 'custom-core');
    writePackage(customCorePath, '@rslint/core', '0.8.1');
    const customCore = fs.realpathSync(customCorePath);

    for (const mode of ['native', 'bridged'] as const) {
      const resolution = resolveRslint({
        folderRoot: root,
        mode,
        corePath: './custom-core',
      });
      expect(resolution.coreDir).toBe(customCore);
      expect(resolution.coreVersion).toBe('0.8.1');
    }
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
