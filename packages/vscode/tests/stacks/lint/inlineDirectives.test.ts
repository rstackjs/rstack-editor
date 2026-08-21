import { describe, expect, it } from '@rstest/core';
import { parseInlineDirectiveRuleTokens } from '../../../src/stacks/lint/inlineDirectives';

function parsedRuleIds(source: string): string[] {
  return parseInlineDirectiveRuleTokens(source).map((token) => token.ruleId);
}

describe('parseInlineDirectiveRuleTokens', () => {
  it('recognizes every rslint and eslint Inline directive form', () => {
    for (const prefix of ['rslint', 'eslint']) {
      for (const directive of [
        'disable',
        'enable',
        'disable-line',
        'disable-next-line',
      ]) {
        expect(parsedRuleIds(`// ${prefix}-${directive} no-console`)).toEqual([
          'no-console',
        ]);
      }
    }
  });

  it('returns comma-separated rule ids with their precise source ranges', () => {
    const source =
      'const value = 1; // rslint-disable no-console, @typescript-eslint/no-explicit-any';
    const tokens = parseInlineDirectiveRuleTokens(source);

    expect(tokens.map((token) => token.ruleId)).toEqual([
      'no-console',
      '@typescript-eslint/no-explicit-any',
    ]);
    for (const token of tokens) {
      expect(source.slice(token.start, token.end)).toBe(token.ruleId);
    }
  });

  it('ignores the description trailer', () => {
    expect(
      parsedRuleIds(
        '// rslint-disable no-console, no-alert -- allowed in this fixture',
      ),
    ).toEqual(['no-console', 'no-alert']);
  });

  it('produces no tokens for wildcard directives', () => {
    expect(parsedRuleIds('// rslint-disable')).toEqual([]);
    expect(parsedRuleIds('// eslint-enable -- restore every rule')).toEqual([]);
  });

  it('recognizes Inline directives in block comments', () => {
    const source =
      '/*\n  eslint-disable-next-line @typescript-eslint/no-explicit-any, no-console\n*/';
    const tokens = parseInlineDirectiveRuleTokens(source);

    expect(tokens.map((token) => token.ruleId)).toEqual([
      '@typescript-eslint/no-explicit-any',
      'no-console',
    ]);
    for (const token of tokens) {
      expect(source.slice(token.start, token.end)).toBe(token.ruleId);
    }
  });

  it('requires the directive to be the first token in the comment body', () => {
    expect(parsedRuleIds('// explanation: rslint-disable no-console')).toEqual(
      [],
    );
    expect(parsedRuleIds('/* note rslint-disable no-console */')).toEqual([]);
  });
});
