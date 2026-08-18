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
        'packages/vscode/e2e/fixtures/**',
        'packages/vscode/e2e/rstest/fixtures/**',
        'packages/vscode/e2e/lint/fixtures/**',
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
      // Resolve-from-project (packages/vscode/AGENTS.md, adaptation #3): the
      // extension ships no tool packages, so extension source may only take
      // *types* from them at compile time. Runtime modules come from the
      // user's project through explicit paths — a static value import would
      // bundle or `require()` the wrong copy.
      files: ['packages/vscode/src/**/*.ts'],
      rules: {
        '@typescript-eslint/no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '@rslint/core',
                  '@rslint/core/*',
                  '@rstest/core',
                  '@rstest/core/*',
                  'rstack',
                  'rstack/*',
                  'jiti',
                ],
                allowTypeImports: true,
                message:
                  'Extension source may only import types from tool packages; load the runtime module from the project (see AGENTS.md, resolve-from-project).',
              },
            ],
          },
        ],
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
    'packages/vscode/e2e/fixtures/**',
    'packages/vscode/e2e/rstest/fixtures/**',
    'packages/vscode/e2e/lint/fixtures/**',
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
