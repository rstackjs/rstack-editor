import { describe, expect, it } from '@rstest/core';
import { decideRslintMode } from '../src/stacks/lint/resolution';

describe('Rslint folder ownership', () => {
  it('gives native config presence precedence anywhere in the folder', () => {
    expect(
      decideRslintMode({
        nativeConfigPaths: ['/workspace/packages/app/rslint.config.ts'],
        rootRstackConfigPath: '/workspace/rstack.config.ts',
      }),
    ).toBe('native');
  });

  it('bridges only a root Rstack config when no native config exists', () => {
    expect(
      decideRslintMode({
        nativeConfigPaths: [],
        rootRstackConfigPath: '/workspace/rstack.config.ts',
      }),
    ).toBe('bridged');
    expect(decideRslintMode({ nativeConfigPaths: [] })).toBeUndefined();
  });
});
