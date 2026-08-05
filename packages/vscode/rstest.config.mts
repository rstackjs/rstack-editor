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
    // An externalized dependency is imported by the chunk itself, so it loads
    // before any `rs.mock` can intervene — and `vscode-languageclient/node`
    // does a bare `require('vscode')` at load time, which no mock can serve
    // from plain Node. Bundling it routes that require through the bundler,
    // where the `vscode` external (and therefore the mock) applies. This is
    // what lets a test import the shell, whose module graph reaches the Rslint
    // stack.
    bundleDependencies: ['vscode-languageclient'],
  },
});
