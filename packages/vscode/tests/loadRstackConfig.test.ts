import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@rstest/core';
import { loadRstackConfig } from '../src/shared/vendored/loadRstackConfig';

// A stand-in for the project's own `rstack` install. It talks to the session
// storage exactly the way rstack's shipped `dist` chunk does — through
// `globalThis.__rstackConfigSessionStorage` — which is the interop contract the
// vendored loader depends on.
const FAKE_RSTACK = `
const getSession = () => globalThis.__rstackConfigSessionStorage?.getStore();

const setConfig = (type, config) => {
  const session = getSession();
  if (!session?.active) {
    throw new Error('The "' + type + '" config must be defined while loading an Rstack config.');
  }
  session.configs[type] = config;
};

export const define = {
  lint: (config) => setConfig('lint', config),
  test: (config) => setConfig('test', config),
};
`;

describe('vendored loadRstackConfig', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rstack-config-'));
    writeFileSync(path.join(dir, 'fake-rstack.mjs'), FAKE_RSTACK);
    writeFileSync(
      path.join(dir, 'rstack.config.mjs'),
      [
        "import { define } from './fake-rstack.mjs';",
        "define.lint([{ name: 'from-rstack-config' }]);",
        "define.test({ name: 'test-project' });",
      ].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('collects define.* calls made by a foreign module instance', async () => {
    const configFilePath = path.join(dir, 'rstack.config.mjs');
    const { configs, filePath } = await loadRstackConfig({ configFilePath });

    expect(filePath).toBe(configFilePath);
    expect(configs.lint).toEqual([{ name: 'from-rstack-config' }]);
    expect(configs.test).toEqual({ name: 'test-project' });
  });

  it('probes a directory when no config path is given', async () => {
    const { filePath } = await loadRstackConfig({ cwd: dir });
    expect(filePath).toBe(path.join(dir, 'rstack.config.mjs'));
  });

  it('reports "no stacks defined" for a directory without a config', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'rstack-empty-'));
    try {
      const { configs, filePath } = await loadRstackConfig({ cwd: empty });
      expect(filePath).toBeNull();
      expect(configs).toEqual({});
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
