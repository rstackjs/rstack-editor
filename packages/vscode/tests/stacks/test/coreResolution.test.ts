import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@rstest/core';
import {
  formatConfiguredCoreNotFoundMessage,
  isModuleNotFoundError,
  missingDependencyCauseOf,
} from '../../../src/stacks/test/coreResolution';

// Resolve for real rather than hand-building an error object: the predicate
// reads a message Node owns, so a fake error would only assert itself.
const resolveError = (specifier: string, from: string): unknown => {
  try {
    require.resolve(specifier, { paths: [from] });
  } catch (e) {
    return e;
  }
  throw new Error(`expected "${specifier}" not to resolve`);
};

describe('isModuleNotFoundError', () => {
  it('should detect a package that is not installed', () => {
    const specifier = '@rstest/definitely-not-installed';
    expect(
      isModuleNotFoundError(resolveError(specifier, __dirname), specifier),
    ).toBe(true);
  });

  it('should reject a package whose entry file is missing', () => {
    // An interrupted install, or a workspace link that has not been built:
    // installed, but unusable. Node reports the missing file, not the package.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstest-vscode-'));
    const pkgDir = path.join(root, 'node_modules', 'broken-package');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      '{"name":"broken-package","version":"1.0.0","main":"./gone.js"}',
    );

    expect(
      isModuleNotFoundError(
        resolveError('broken-package', root),
        'broken-package',
      ),
    ).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('should ignore other errors', () => {
    expect(isModuleNotFoundError(new Error('boom'), 'boom')).toBe(false);
    expect(isModuleNotFoundError('MODULE_NOT_FOUND', 'x')).toBe(false);
    expect(isModuleNotFoundError(undefined, 'x')).toBe(false);
  });
});

describe('core-not-found messages', () => {
  it('should point at the configured package path instead of the install hint', () => {
    const message = formatConfiguredCoreNotFoundMessage(
      '/repo/vendor/core/package.json',
    );
    expect(message).toContain('/repo/vendor/core/package.json');
    expect(message).not.toContain('Install the project dependencies');
  });
});

describe('missingDependencyCauseOf', () => {
  // Same reasoning as `resolveError`: the classifier reads a code and a
  // message Node owns, so the errors come from Node's own loaders.
  const importError = async (specifier: string): Promise<unknown> => {
    try {
      await import(specifier);
    } catch (e) {
      return e;
    }
    throw new Error(`expected "${specifier}" not to import`);
  };

  it('should name a package an ESM config failed to import', async () => {
    expect(
      missingDependencyCauseOf(
        await importError('@rstest/definitely-not-installed'),
      ),
    ).toContain("'@rstest/definitely-not-installed'");
  });

  it('should keep a CJS failure to one line, without the require stack', () => {
    const cause = missingDependencyCauseOf(
      resolveError('@rstest/definitely-not-installed', __dirname),
    );
    expect(cause).toContain("'@rstest/definitely-not-installed'");
    // The not-installed warn is one line, no stack (AGENTS.md); Node's
    // MODULE_NOT_FOUND message embeds a multi-line `Require stack:`.
    expect(cause).not.toContain('\n');
    expect(cause).not.toContain('Require stack');
  });

  it('should leave a missing relative or absolute import to the error report', () => {
    // A typo'd `./helper` or a missing generated file is a source problem —
    // installing dependencies cannot fix it, so it must not be classified as
    // the not-installed state. The ESM loader reports relative imports as
    // absolute paths, which the absolute case stands in for.
    expect(
      missingDependencyCauseOf(resolveError('./definitely-missing', __dirname)),
    ).toBe(undefined);
    expect(
      missingDependencyCauseOf(
        resolveError(
          path.join(os.tmpdir(), 'definitely-missing.js'),
          os.tmpdir(),
        ),
      ),
    ).toBe(undefined);
  });

  it('should leave every other failure to the full error report', () => {
    expect(missingDependencyCauseOf(new SyntaxError('Unexpected token'))).toBe(
      undefined,
    );
    expect(missingDependencyCauseOf(new Error("Cannot find package 'x'"))).toBe(
      undefined,
    );
    expect(missingDependencyCauseOf("Cannot find package 'x'")).toBe(undefined);
    expect(missingDependencyCauseOf(undefined)).toBe(undefined);
  });
});
