import localPlugin from './local-plugin.mjs';

/**
 * A real Rslint flat config: it is loaded by the language server through the
 * project's own `@rslint/core` (this extension ships none), and by the
 * plugin-host regression smoke test through `createPluginLintHost`.
 *
 * Besides the local plugin rule the smoke test asserts on, two native rules
 * are enabled so the F5 playground shows diagnostics whose derived docs links
 * resolve to real pages on rslint.rs (a local plugin rule has no docs page).
 * A config entry takes either community plugin instances or built-in plugin
 * names, never both, so the two live in separate entries.
 */
export default [
  {
    files: ['src/**/*.ts'],
    plugins: { local: localPlugin },
    rules: {
      'local/no-null': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    plugins: ['@typescript-eslint'],
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
];
