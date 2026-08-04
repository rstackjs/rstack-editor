import { defineConfig } from '@rstest/core';

export default defineConfig({
  include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
  // The E2E suite runs in a VS Code extension host, not in Rstest.
  exclude: ['**/tests/e2e/**'],
  globals: true,
  name: 'rstack-editor',
  output: {
    externals: {
      vscode: 'commonjs vscode',
    },
  },
});
