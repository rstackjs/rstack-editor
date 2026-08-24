import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@rstest/core';
import {
  formatConfigDependencyMissingMessage,
  formatConfiguredCoreNotFoundMessage,
  isMissingDependencyError,
  isModuleNotFoundError,
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

describe('isMissingDependencyError', () => {
  // Same reasoning as `resolveError`: the predicate reads a code Node owns,
  // so the errors come from Node's own loaders.
  const importError = async (specifier: string): Promise<unknown> => {
    try {
      await import(specifier);
    } catch (e) {
      return e;
    }
    throw new Error(`expected "${specifier}" not to import`);
  };

  it('should detect a package an ESM config failed to import', async () => {
    expect(
      isMissingDependencyError(
        await importError('@rstest/definitely-not-installed'),
      ),
    ).toBe(true);
  });

  it('should detect a package a CJS config failed to require', () => {
    expect(
      isMissingDependencyError(
        resolveError('@rstest/definitely-not-installed', __dirname),
      ),
    ).toBe(true);
  });

  it('should leave every other failure to the full error report', () => {
    expect(isMissingDependencyError(new SyntaxError('Unexpected token'))).toBe(
      false,
    );
    expect(isMissingDependencyError(new Error("Cannot find package 'x'"))).toBe(
      false,
    );
    expect(isMissingDependencyError("Cannot find package 'x'")).toBe(false);
    expect(isMissingDependencyError(undefined)).toBe(false);
  });
});

describe('formatConfigDependencyMissingMessage', () => {
  it("should name the config, the loader's own words and the way out", () => {
    const message = formatConfigDependencyMissingMessage(
      '/repo/templates/app/rstack.config.ts',
      "Cannot find package '@rsbuild/plugin-react' imported from /repo/templates/app/rstack.config.ts",
    );
    expect(message).toContain('/repo/templates/app/rstack.config.ts');
    expect(message).toContain("Cannot find package '@rsbuild/plugin-react'");
    expect(message).toContain('Install the project dependencies');
  });
});
