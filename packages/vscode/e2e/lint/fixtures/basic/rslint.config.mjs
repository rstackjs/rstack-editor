// Ported from web-infra-dev/rslint `packages/rslint/fixtures/rslint.json`
// (origin/main), converted to a JS config: `rslint.json` is deprecated
// upstream and not supported by this extension — it is not a detection signal,
// so the fixture must carry the equivalent `rslint.config.mjs`
// for the suite to run at all. The rule set is upstream's, verbatim.
export default [
  {
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.json'],
      },
    },
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unnecessary-type-constraint': 'warn',
      '@typescript-eslint/adjacent-overload-signatures': 'error',
      '@typescript-eslint/array-type': 'error',
      '@typescript-eslint/class-literal-property-style': 'error',
      '@typescript-eslint/no-empty-function': 'error',
      '@typescript-eslint/no-empty-interface': 'error',
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-namespace': 'error',
      '@typescript-eslint/no-wrapper-object-types': 'error',
      '@typescript-eslint/no-inferrable-types': 'error',
      'prefer-const': 'off',
      'one-var': 'off',
    },
    plugins: ['@typescript-eslint'],
  },
];
