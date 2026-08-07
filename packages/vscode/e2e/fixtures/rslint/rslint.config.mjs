import localPlugin from './local-plugin.mjs';

/**
 * A real Rslint flat config: it is loaded by the language server through the
 * project's own `@rslint/core` (this extension ships none), and by the
 * plugin-host regression smoke test through `createPluginLintHost`.
 */
export default [
  {
    files: ['src/**/*.ts'],
    plugins: { local: localPlugin },
    rules: {
      'local/no-null': 'error',
    },
  },
];
