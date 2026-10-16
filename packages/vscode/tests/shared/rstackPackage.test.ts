import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from '@rstest/core';
import { resolveRstackPackageJson } from '../../src/shared/rstackPackage';
import {
  installPackage,
  removeTemporaryDirectories,
  temporaryDirectory,
  writePackage,
} from '../stacks/lint/packageFixtures';

afterEach(removeTemporaryDirectories);

describe('resolveRstackPackageJson', () => {
  it.each([
    'infra/node_modules/rstack',
    'infra/node_modules/rstack/package.json',
  ])(
    'resolves a relative setting from the folder root, outside the walk-up (%s)',
    (configured) => {
      // The #103 layout: rstack only under `infra/`, invisible to a walk-up
      // from the folder root.
      const root = temporaryDirectory();
      const rstackDir = installPackage(
        path.join(root, 'infra'),
        'rstack',
        '0.8.4',
      );

      expect(resolveRstackPackageJson(root, configured)).toEqual({
        kind: 'found',
        packageJsonPath: path.join(rstackDir, 'package.json'),
      });
    },
  );

  it('wins over an installation the walk-up would find', () => {
    const root = temporaryDirectory();
    installPackage(root, 'rstack', '0.8.3');
    const pinned = writePackage(
      path.join(root, 'tools', 'rstack'),
      'rstack',
      '0.8.4',
    );

    expect(resolveRstackPackageJson(root, pinned)).toEqual({
      kind: 'found',
      packageJsonPath: path.join(pinned, 'package.json'),
    });
  });

  it('returns the realpath, so a pnpm store layout keeps its siblings', () => {
    // Lint and test resolve their cores from the rstack directory; through
    // the `node_modules/rstack` symlink they would miss rstack's dependencies,
    // which pnpm places beside the store path.
    const root = temporaryDirectory();
    const storeDir = writePackage(
      path.join(
        root,
        'node_modules',
        '.pnpm',
        'rstack@0.8.4',
        'node_modules',
        'rstack',
      ),
      'rstack',
      '0.8.4',
    );
    const link = path.join(root, 'infra', 'node_modules', 'rstack');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(storeDir, link, 'junction');

    expect(resolveRstackPackageJson(root, 'infra/node_modules/rstack')).toEqual(
      {
        kind: 'found',
        packageJsonPath: path.join(storeDir, 'package.json'),
      },
    );
  });

  it('treats a missing path as a setting error, not a missing install', () => {
    const root = temporaryDirectory();
    // An installation the walk-up would find must not mask the mistake.
    installPackage(root, 'rstack', '0.8.4');

    const resolution = resolveRstackPackageJson(
      root,
      'infra/node_modules/rstack',
    );

    expect(resolution.kind).toBe('invalid-setting');
    const message = resolution.kind === 'invalid-setting' && resolution.message;
    expect(message).toContain('rstack.rstackCli.packagePath');
    expect(message).toContain(
      path.join(root, 'infra', 'node_modules', 'rstack', 'package.json'),
    );
  });

  it('rejects a package that is not rstack', () => {
    const root = temporaryDirectory();
    const coreDir = installPackage(root, '@rslint/core', '0.9.5');

    const resolution = resolveRstackPackageJson(root, coreDir);

    expect(resolution.kind).toBe('invalid-setting');
    expect(
      resolution.kind === 'invalid-setting' && resolution.message,
    ).toContain('is not the "rstack" package');
  });
});
