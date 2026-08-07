// Rstack configuration guide: https://rstack.rs/config
//
// This fixture has NO tool-native config: no `rslint.config.*`, no
// `rstest.config.*`. `rstack.config.ts` is the single config source, and its
// presence alone must light the Rstest and rs fmt stacks (Rslint via
// `define.lint()` is deferred — TODO(rstack-bridge)) — `rs lint` and
// `rs test` inject rstack's own shim configs, so a tool-native file never has
// to exist.
import { define } from 'rstack';

define.lint([
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-debugger': 'error',
    },
  },
]);

define.test({
  name: 'rstack-editor-fixture-rstack',
  include: ['tests/**/*.test.ts'],
});
