import { describe, expect, it } from '@rstest/core';
import { ruleDocsUrl } from '../../../src/stacks/lint/ruleDocumentation';

describe('ruleDocsUrl', () => {
  it('derives a prefixed Rule docs link', () => {
    expect(ruleDocsUrl('@typescript-eslint/no-floating-promises')).toBe(
      'https://rslint.rs/rules/typescript-eslint/no-floating-promises',
    );
  });

  it('derives a core Rule docs link under eslint', () => {
    expect(ruleDocsUrl('no-console')).toBe(
      'https://rslint.rs/rules/eslint/no-console',
    );
  });
});
