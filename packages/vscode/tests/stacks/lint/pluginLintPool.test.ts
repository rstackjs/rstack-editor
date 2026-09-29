import { expect, it, rs } from '@rstest/core';
import { PluginLintPool } from '../../../src/stacks/lint/worker/PluginLintPool';
import { WorkerLogger } from '../../../src/stacks/lint/worker/logger';

it('logs the full error once per failure episode and again after recovery then re-failure', async () => {
  const descriptors = [
    { configPath: '/project/rslint.config.mjs', configDirectory: '/project' },
  ];
  const logger = new WorkerLogger();
  const log = rs.spyOn(logger, 'error').mockImplementation(() => {});
  const error = new Error('plugin exploded\nfull stack detail');
  const createHost = rs.fn().mockRejectedValue(error);
  const pool = new PluginLintPool(logger, createHost);
  try {
    await pool.prepare(descriptors, 'same', 'initial');
    expect(pool.configDependencyStatus).toEqual({
      kind: 'missing',
      failure: {
        configPath: '/project/rslint.config.mjs',
        cause: 'plugin exploded',
        plugin: true,
      },
    });
    await pool.commit('initial');
    await pool.prepare(descriptors, 'same', 'retry');
    expect(createHost).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual([
      'Failed to initialize ESLint-plugin host',
      error,
    ]);
    await pool.abort('retry');
    createHost.mockResolvedValue({
      lint: async () => ({ results: [] }),
      shutdown: async () => {},
    });
    await pool.prepare(descriptors, 'same', 'fixed');
    await pool.commit('fixed');
    expect(pool.configDependencyStatus).toEqual({ kind: 'ok' });
    createHost.mockRejectedValue(error);
    await pool.prepare(descriptors, 'changed', 'broken-again');
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]).toEqual([
      'Failed to initialize ESLint-plugin host',
      error,
    ]);
  } finally {
    await pool.dispose();
  }
});

it('keeps a failure visible when a successful prepare is aborted', async () => {
  const descriptors = [
    { configPath: '/project/rslint.config.mjs', configDirectory: '/project' },
  ];
  const logger = new WorkerLogger();
  rs.spyOn(logger, 'error').mockImplementation(() => {});
  const createHost = rs.fn().mockRejectedValue(new Error('broken plugin'));
  const pool = new PluginLintPool(logger, createHost);
  try {
    await pool.prepare(descriptors, 'broken', 'initial');
    await pool.commit('initial');
    const failure = pool.configDependencyStatus;
    createHost.mockResolvedValue({
      lint: async () => ({ results: [] }),
      shutdown: async () => {},
    });
    expect(await pool.prepare(descriptors, 'fixed', 'aborted')).toBe(true);
    expect(pool.configDependencyStatus).toEqual(failure);
    await pool.abort('aborted');
    expect(pool.configDependencyStatus).toEqual(failure);
    await pool.prepare([], 'empty', 'removed');
    expect(pool.configDependencyStatus).toEqual(failure);
    await pool.commit('removed');
    expect(pool.configDependencyStatus).toEqual({ kind: 'ok' });
  } finally {
    await pool.dispose();
  }
});
