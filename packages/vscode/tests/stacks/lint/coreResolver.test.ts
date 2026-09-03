/**
 * What `CoreResolver` adds on top of `resolveRslint` (`resolution.test.ts`
 * owns the chain walk itself): the physical identity of a core and the
 * runtime key built from it — the two things rslint #1617 turned into
 * lifecycle decisions. Pinned here instead of in an Electron E2E run because
 * the resolver imports only *types* from `vscode`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from '@rstest/core';
import type { TextDocument, WorkspaceFolder } from 'vscode';
import { CoreResolver } from '../../../src/stacks/lint/CoreResolver';
import { RslintVersionMismatchError } from '../../../src/stacks/lint/status';
import {
  installPackage,
  installShim,
  removeTemporaryDirectories,
  temporaryDirectory,
  writePackage,
} from './packageFixtures';

function folderOf(root: string, name = 'fixture'): WorkspaceFolder {
  return {
    name,
    index: 0,
    uri: { toString: () => `file://${root}`, fsPath: root },
  } as unknown as WorkspaceFolder;
}

function documentAt(filePath: string): Pick<TextDocument, 'uri'> {
  return { uri: { fsPath: filePath } } as unknown as Pick<TextDocument, 'uri'>;
}

afterEach(removeTemporaryDirectories);

describe('CoreResolver', () => {
  it('identifies a core by its real path, so a symlink is the copy it points at', async () => {
    const root = temporaryDirectory();
    const store = writePackage(
      path.join(root, 'store', 'core-0.9.0'),
      '@rslint/core',
      '0.9.0',
    );
    const link = path.join(root, 'app', 'node_modules', '@rslint', 'core');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(store, link, 'dir');
    const app = path.join(root, 'app');

    const resolved = await new CoreResolver().resolve(
      documentAt(path.join(app, 'src', 'index.ts')),
      folderOf(app),
      { mode: 'native' },
    );

    expect(resolved.installation.identity).toBe(store);
  });

  it('keeps two same-version copies apart: one folder, two Lint runtimes', async () => {
    const root = temporaryDirectory();
    const left = path.join(root, 'left');
    const right = path.join(root, 'right');
    installPackage(left, '@rslint/core', '0.9.0');
    installPackage(right, '@rslint/core', '0.9.0');
    const folder = folderOf(root);
    const resolver = new CoreResolver();

    const fromLeft = await resolver.resolve(
      documentAt(path.join(left, 'index.ts')),
      folder,
      { mode: 'native' },
    );
    const fromRight = await resolver.resolve(
      documentAt(path.join(right, 'index.ts')),
      folder,
      { mode: 'native' },
    );

    expect(fromLeft.installation.version).toBe(fromRight.installation.version);
    expect(fromLeft.installation.identity).not.toBe(
      fromRight.installation.identity,
    );
    expect(fromLeft.key).not.toBe(fromRight.key);
    expect(fromLeft.key.startsWith(`${folder.uri.toString()}\0`)).toBe(true);
  });

  it('gives one folder different runtime keys for its native and bridged ownership of the same core', async () => {
    // Protocol 2 locks `configPath` for the server's lifetime (ADR 0003), so a
    // native <-> bridged flip must replace the runtime even when both modes
    // land on the same physical core. Upstream, which has no bridge, keys on
    // the core alone.
    const root = temporaryDirectory();
    installPackage(root, '@rslint/core', '0.9.0');
    const rstack = installPackage(root, 'rstack', '0.7.2');
    const shimPath = installShim(rstack);
    const folder = folderOf(root);
    const resolver = new CoreResolver();
    const document = documentAt(path.join(root, 'src', 'index.ts'));

    const native = await resolver.resolve(document, folder, {
      mode: 'native',
    });
    const bridged = await resolver.resolve(document, folder, {
      mode: 'bridged',
    });

    expect(bridged.installation.identity).toBe(native.installation.identity);
    expect(bridged.key).not.toBe(native.key);
    expect(bridged.installation.shimPath).toBe(shimPath);
  });

  it('refuses a core below the floor and names its directory', async () => {
    // With several cores in one folder, "0.8.2 is not supported" alone would
    // not say which one to fix.
    const root = temporaryDirectory();
    const core = installPackage(root, '@rslint/core', '0.8.2');
    const resolve = () =>
      new CoreResolver().resolve(
        documentAt(path.join(root, 'src', 'index.ts')),
        folderOf(root),
        { mode: 'native' },
      );

    await expect(resolve()).rejects.toThrow(RslintVersionMismatchError);
    await expect(resolve()).rejects.toThrow(core);
  });
});
