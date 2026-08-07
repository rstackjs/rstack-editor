import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@rstest/core';
import type { StackState, StatusReporter } from '../../types';
import { resolveRstackShim } from './bridge';
import { logger } from './logger';
import { status } from './status';

// Resolution is exercised for real (a temporary `node_modules/rstack` tree)
// rather than by mocking `nodeRequire`: the whole point of the bridge is that
// Node's own algorithm finds the shim the CLI would inject, so a mocked
// resolver would only assert itself.

const logged: string[] = [];
const reported: StackState[] = [];

const channel = {
  debug: (message: string) => logged.push(message),
  info: (message: string) => logged.push(message),
  warn: (message: string) => logged.push(message),
  error: (message: string) => logged.push(message),
  show: () => {},
  dispose: () => {},
};

const reporter: StatusReporter = {
  stack: 'rstest',
  report: (state) => reported.push(state),
  starting: (detail) => reported.push({ kind: 'starting', detail }),
  running: (detail) => reported.push({ kind: 'running', detail }),
  crashed: (detail) => reported.push({ kind: 'crashed', detail }),
  versionMismatch: (detail) =>
    reported.push({ kind: 'version-mismatch', detail }),
};

const tmpDirs: string[] = [];

// `os.tmpdir()` is a symlink on macOS (`/var` -> `/private/var`) and Node's
// resolver returns the real path, so every fixture path has to be realpath'd
// before it is compared.
const makeTmpDir = (): string => {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'rstack-bridge-')),
  );
  tmpDirs.push(dir);
  return dir;
};

/**
 * A workspace whose `rstack.config.ts` sits next to a `node_modules/rstack`.
 * `version: null` omits the `version` field, `shim: false` omits
 * `dist/rstestConfig.js`.
 */
const createWorkspace = ({
  version = '0.3.5',
  shim = true,
}: { version?: string | null; shim?: boolean } = {}): string => {
  const root = makeTmpDir();
  const configDir = path.join(root, 'app');
  const rstackDir = path.join(configDir, 'node_modules', 'rstack');
  fs.mkdirSync(path.join(rstackDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'rstack.config.ts'),
    'export default {};\n',
  );
  fs.writeFileSync(
    path.join(rstackDir, 'package.json'),
    JSON.stringify({
      name: 'rstack',
      ...(version === null ? {} : { version }),
      main: 'dist/index.js',
    }),
  );
  if (shim) {
    fs.writeFileSync(
      path.join(rstackDir, 'dist', 'rstestConfig.js'),
      'module.exports = {};\n',
    );
  }
  return configDir;
};

beforeEach(() => {
  logged.length = 0;
  reported.length = 0;
  logger.bind(channel as never);
  status.bind(reporter);
});

afterEach(() => {
  logger.unbind();
  status.unbind();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveRstackShim', () => {
  it('resolves the shipped Rstest config shim next to the rstack config', () => {
    const configDir = createWorkspace();

    const shim = resolveRstackShim(configDir);

    expect(shim).toBeDefined();
    expect(shim?.version).toBe('0.3.5');
    // The same file `rs test` injects with `--config`.
    expect(shim?.configFilePath).toBe(
      path.join(configDir, 'node_modules', 'rstack', 'dist', 'rstestConfig.js'),
    );
    expect(fs.existsSync(shim!.configFilePath)).toBe(true);
  });

  it('reports nothing when the rstack package is not installed', () => {
    const root = makeTmpDir();

    expect(resolveRstackShim(root)).toBeUndefined();
    expect(logged.join('\n')).toContain('Cannot find the "rstack" package');
    expect(reported).toEqual([]);
  });

  it('stays silent on a repeated failure', () => {
    const root = makeTmpDir();

    expect(resolveRstackShim(root, { silent: true })).toBeUndefined();
    expect(logged).toEqual([]);
  });

  it('refuses an rstack install that ships no Rstest shim', () => {
    const configDir = createWorkspace({ shim: false });

    expect(resolveRstackShim(configDir)).toBeUndefined();
    expect(logged.join('\n')).toContain('rstestConfig.js');
  });

  it('refuses an rstack older than the support matrix floor', () => {
    const configDir = createWorkspace({ version: '0.3.4' });

    expect(resolveRstackShim(configDir)).toBeUndefined();
    expect(reported).toEqual([
      {
        kind: 'version-mismatch',
        detail:
          'rstack 0.3.4 is not supported, this extension requires >=0.3.5',
      },
    ]);
  });

  it('accepts an rstack whose version cannot be read', () => {
    const configDir = createWorkspace({ version: null });

    const shim = resolveRstackShim(configDir);

    expect(shim).toBeDefined();
    expect(shim?.version).toBeUndefined();
    expect(reported).toEqual([]);
  });
});
