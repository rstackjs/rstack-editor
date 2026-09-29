import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@rstest/core';
import {
  classifyMissingDependencyMessage,
  missingDependencyCauseOf,
} from '../../src/shared/missingDependency';

// Resolve for real rather than hand-building an error object: the classifier
// reads a code and a message Node owns, so a fake error would only assert
// itself.
const resolveError = (specifier: string, from: string): unknown => {
  try {
    require.resolve(specifier, { paths: [from] });
  } catch (e) {
    return e;
  }
  throw new Error(`expected "${specifier}" not to resolve`);
};

describe('missingDependencyCauseOf', () => {
  // Same reasoning as `resolveError`: the errors come from Node's own
  // loaders.
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

  it('treats a missing subpath of an installed package as not installed', () => {
    // No filesystem lookup since #52; the fixture only proves Node still reports MODULE_NOT_FOUND for a present package's missing subpath.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstest-vscode-'));
    try {
      const pkgDir = path.join(root, 'node_modules', 'installed-package');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        '{"name":"installed-package","version":"1.0.0"}',
      );

      expect(
        missingDependencyCauseOf(
          resolveError('installed-package/missing', root),
        ),
      ).toContain("'installed-package/missing'");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

describe('classifyMissingDependencyMessage', () => {
  it('classifies loader messages without requiring an Error code', () => {
    expect(
      classifyMissingDependencyMessage(
        "Cannot find package '@scope/missing' imported from /project/config.mjs",
      ),
    ).toBe(
      "Cannot find package '@scope/missing' imported from /project/config.mjs",
    );
  });

  it('rejects non-loader messages even without the Error-code gate', () => {
    expect(
      classifyMissingDependencyMessage(
        "Configuration says Cannot find package 'missing'",
      ),
    ).toBe(undefined);
  });
});
