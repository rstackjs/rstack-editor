import { describe, expect, it, rs } from '@rstest/core';
import type { Diagnostic } from 'vscode';

rs.mock('vscode', () => ({
  Uri: {
    parse: (value: string) => ({ value, toString: () => value }),
  },
}));

import { enrichRslintDiagnostic } from '../../../src/stacks/lint/diagnosticEnrichment';

describe('enrichRslintDiagnostic', () => {
  it('sets the diagnostic code and Rule docs link and strips the prefix', () => {
    const diagnostic = {
      message: '[no-console] Unexpected console statement.',
    } as Diagnostic;

    enrichRslintDiagnostic(diagnostic);

    expect(diagnostic.message).toBe('Unexpected console statement.');
    expect(diagnostic.code).toMatchObject({ value: 'no-console' });
    expect(
      typeof diagnostic.code === 'object'
        ? diagnostic.code.target.toString()
        : undefined,
    ).toBe('https://rslint.rs/rules/eslint/no-console');
  });

  it('passes non-matching diagnostics through untouched', () => {
    for (const message of [
      'Unexpected console statement.',
      '[no-console]Unexpected console statement.',
      'prefix [no-console] Unexpected console statement.',
      '[not a rule] Unexpected console statement.',
    ]) {
      const diagnostic = { message } as Diagnostic;
      const before = { ...diagnostic };

      enrichRslintDiagnostic(diagnostic);

      expect(diagnostic).toEqual(before);
    }
  });

  it('yields to an object code with a server-published target', () => {
    const diagnostic = {
      message: '[no-console] Unexpected console statement.',
      code: {
        value: 'no-console',
        target: {
          toString: () => 'https://server.example/rules/no-console',
        },
      },
    } as Diagnostic;
    const before = { ...diagnostic };

    enrichRslintDiagnostic(diagnostic);

    expect(diagnostic).toEqual(before);
  });

  it('upgrades a primitive code with a Rule docs link and strips the prefix', () => {
    const diagnostic = {
      message: '[parsed-rule] Unexpected console statement.',
      code: 'no-console',
    } as Diagnostic;

    enrichRslintDiagnostic(diagnostic);

    expect(diagnostic.message).toBe('Unexpected console statement.');
    expect(diagnostic.code).toMatchObject({ value: 'no-console' });
    expect(
      typeof diagnostic.code === 'object'
        ? diagnostic.code.target.toString()
        : undefined,
    ).toBe('https://rslint.rs/rules/eslint/no-console');
  });
});
