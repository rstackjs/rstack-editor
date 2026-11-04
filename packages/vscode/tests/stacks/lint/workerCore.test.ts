/**
 * `loadCoreInstallation` is the worker's last hop: it loads the project's
 * `@rslint/core` and refuses a package that cannot produce a runnable LSP
 * binary. Upstream asserted this in `CoreResolver`, because the extension host
 * loaded the core there; since rslint #1617's worker split the check lives in
 * `worker/core.ts`, and the E2E resolver suite cannot reach it (the host never
 * loads project code — ADR 0003). The stub package keeps this a unit test: the
 * real core is a fixture dependency, not a unit-test one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from '@rstest/core';
import { loadCoreInstallation } from '../../../src/stacks/lint/worker/core';
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from './packageFixtures';

afterEach(removeTemporaryDirectories);

/**
 * A stub `@rslint/core` with only the shape `loadCoreInstallation` validates,
 * whose `resolveRslintBinary()` answers `binaryPath` — so the binary guard is
 * what the test exercises. The self-referencing `exports` map is what lets the
 * package's own `createRequire` resolve `@rslint/core/config-loader`, exactly
 * as the published package does.
 */
function writeStubCore(root: string, binaryPath: string): string {
  const coreDirectory = path.join(root, 'node_modules', '@rslint', 'core');
  fs.mkdirSync(coreDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(coreDirectory, 'package.json'),
    JSON.stringify({
      name: '@rslint/core',
      version: '0.9.0',
      exports: {
        '.': './index.mjs',
        './config-loader': './config-loader.mjs',
        './eslint-plugin': './eslint-plugin.mjs',
      },
    }),
  );
  fs.writeFileSync(
    path.join(coreDirectory, 'config-loader.mjs'),
    [
      'export class ConfigModuleHost {',
      '  constructor(options) {',
      '    this.options = options;',
      '  }',
      '}',
      'export const CONFIG_DISCOVERY_PROTOCOL_VERSION = 3;',
      'export const loadConfigFileFresh = async () => ({});',
      'export function resolveRslintBinary() {',
      `  return ${JSON.stringify(binaryPath)};`,
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(coreDirectory, 'eslint-plugin.mjs'),
    'export function createPluginLintHost() {\n  return {};\n}\n',
  );
  fs.writeFileSync(path.join(coreDirectory, 'index.mjs'), 'export {};\n');
  return coreDirectory;
}

describe('lint worker core installation', () => {
  it('rejects a core package whose binary is missing', async () => {
    const root = temporaryDirectory('rslint-worker-core-');
    const binaryPath = path.join(root, 'missing', 'rslint');
    const coreDirectory = writeStubCore(root, binaryPath);

    await expect(loadCoreInstallation(coreDirectory)).rejects.toThrow(
      `Rslint binary does not exist at ${binaryPath}`,
    );
  });

  it('rejects a core package whose binary is not a file', async () => {
    const root = temporaryDirectory('rslint-worker-core-');
    const binaryPath = path.join(root, 'rslint-directory');
    fs.mkdirSync(binaryPath);
    const coreDirectory = writeStubCore(root, binaryPath);

    await expect(loadCoreInstallation(coreDirectory)).rejects.toThrow(
      `Rslint binary is not a file: ${binaryPath}`,
    );
  });
});
