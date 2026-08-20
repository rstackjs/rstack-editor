// Upstream uses rslint.json. This equivalent native config is intentional:
// deprecated JSON configs are not supported by the unified extension.
export default [
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.json'],
      },
    },
    rules: {
      'import/no-cycle': 'error',
      'no-var': 'error',
    },
    plugins: ['import'],
  },
];
