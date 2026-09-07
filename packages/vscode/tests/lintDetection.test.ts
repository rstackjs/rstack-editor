import path from 'node:path';
import { describe, expect, it } from '@rstest/core';
import {
  decideRslintMode,
  rootRstackConfigPath,
} from '../src/stacks/lint/resolution';

describe('Rslint folder ownership', () => {
  it('attributes bridge failures to the root config regardless of discovery order', () => {
    const folder = path.resolve('/workspace');
    const root = path.join(folder, 'rstack.config.ts');
    const nested = path.join(folder, 'packages', 'app', 'rstack.config.ts');
    expect(rootRstackConfigPath(folder, [nested, root])).toBe(root);
    expect(rootRstackConfigPath(folder, [root, nested])).toBe(root);
    expect(rootRstackConfigPath(folder, [nested])).toBeUndefined();
  });

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
