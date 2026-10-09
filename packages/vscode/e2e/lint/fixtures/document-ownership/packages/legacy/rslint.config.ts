// Owns the documents under `packages/legacy` only (ADR 0006).
export default [
  {
    files: ['**/*.ts'],
    rules: {
      'no-empty': 'error',
    },
  },
];
