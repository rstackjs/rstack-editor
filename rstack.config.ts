// Rstack configuration guide: https://rstack.rs/config
import { define } from 'rstack';

define.lint(async () => {
  const { ts } = await import('rstack/lint');
  return [
    {
      ignores: [
        '**/dist/**',
        '**/tests-dist/**',
        '**/.vscode-test/**',
        // Fixture projects are user-land sample code, not extension source.
        'packages/vscode/tests/e2e/fixtures/**',
        'packages/vscode/tests/e2e/rstest/fixtures/**',
        'packages/vscode/tests/e2e/lint/fixtures/**',
      ],
    },
    ts.configs.recommended,
    {
      rules: {
        // The copied upstream extension code relies on these patterns
        // (`nodeRequire`, ambient anys around the VS Code test APIs).
        '@typescript-eslint/ban-ts-comment': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-require-imports': 'off',
      },
    },
    {
      languageOptions: {
        parserOptions: {
          project: ['./packages/vscode/tsconfig.json'],
        },
      },
    },
  ];
});

define.fmt({
  singleQuote: true,
  sortPackageJson: true,
  proseWrap: 'never',
  ignorePatterns: [
    // E2E fixture sources are asserted on byte-for-byte (diagnostic ranges,
    // autofix results, AST-collected line numbers) — formatting breaks them.
    'packages/vscode/tests/e2e/fixtures/**',
    'packages/vscode/tests/e2e/rstest/fixtures/**',
    'packages/vscode/tests/e2e/lint/fixtures/**',
    // Vendored agent skills mirror mattpocock/skills byte-for-byte;
    // skills-lock.json hashes them, so formatting causes update churn.
    '.agents/**',
    '.claude/skills/**',
  ],
});

define.staged({
  '*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}': ['rs lint --fix', 'rs fmt'],
  '*.{json,jsonc,md,mdx,css,html,yml,yaml}': 'rs fmt',
});
