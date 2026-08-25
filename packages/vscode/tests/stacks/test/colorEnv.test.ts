import { describe, expect, it } from '@rstest/core';
import {
  injectForceColor,
  retractForceColorIfDisabled,
} from '../../../src/stacks/test/shared/colorEnv';

// The pair mirrors the CLI's getForceColorEnv semantics (adaptation #9):
// inject only when the user expressed no preference, retract only what was
// injected, and only when the config turned color off.

describe('injectForceColor', () => {
  it('injects when neither standard is set', () => {
    const env: NodeJS.ProcessEnv = {};
    injectForceColor(env);
    expect(env.FORCE_COLOR).toBe('1');
  });

  it('respects a user-set NO_COLOR', () => {
    const env: NodeJS.ProcessEnv = { NO_COLOR: '1' };
    injectForceColor(env);
    expect(env.FORCE_COLOR).toBeUndefined();
  });

  it('respects a user-set FORCE_COLOR, including an explicit off', () => {
    const env: NodeJS.ProcessEnv = { FORCE_COLOR: '0' };
    injectForceColor(env);
    expect(env.FORCE_COLOR).toBe('0');
  });
});

describe('retractForceColorIfDisabled', () => {
  // Both paths also assert the internal marker is gone: pool processes and
  // user test code must not observe an extension-only variable the bare CLI
  // never supplies.
  it('retracts the injection when the config set NO_COLOR', () => {
    const env: NodeJS.ProcessEnv = {};
    injectForceColor(env);
    env.NO_COLOR = '1'; // config load
    retractForceColorIfDisabled(env);
    expect(env.FORCE_COLOR).toBeUndefined();
    expect(env.NO_COLOR).toBe('1');
    expect(env.RSTACK_FORCE_COLOR_INJECTED).toBeUndefined();
  });

  it('leaves the injection alone when the config set nothing', () => {
    const env: NodeJS.ProcessEnv = {};
    injectForceColor(env);
    retractForceColorIfDisabled(env);
    expect(env.FORCE_COLOR).toBe('1');
    expect(env.RSTACK_FORCE_COLOR_INJECTED).toBeUndefined();
  });

  it('preserves a FORCE_COLOR the config overwrote, even beside its NO_COLOR', () => {
    // The config owns the value now; the bare CLI — deciding after config
    // load — would leave both intact. Only the injected '1' may be removed.
    const env: NodeJS.ProcessEnv = {};
    injectForceColor(env);
    env.FORCE_COLOR = '3'; // config load
    env.NO_COLOR = '1'; // config load
    retractForceColorIfDisabled(env);
    expect(env.FORCE_COLOR).toBe('3');
    expect(env.RSTACK_FORCE_COLOR_INJECTED).toBeUndefined();
  });

  it('never touches a user-set FORCE_COLOR (that conflict warns in the bare CLI too)', () => {
    const env: NodeJS.ProcessEnv = { FORCE_COLOR: '1' };
    injectForceColor(env);
    env.NO_COLOR = '1'; // config load
    retractForceColorIfDisabled(env);
    expect(env.FORCE_COLOR).toBe('1');
  });

  it('survives repeated config evaluations in one worker process', () => {
    // `init()` runs once per RPC call; a second retraction after the first
    // must stay a no-op.
    const env: NodeJS.ProcessEnv = {};
    injectForceColor(env);
    env.NO_COLOR = '1';
    retractForceColorIfDisabled(env);
    retractForceColorIfDisabled(env);
    expect(env.FORCE_COLOR).toBeUndefined();
  });
});
