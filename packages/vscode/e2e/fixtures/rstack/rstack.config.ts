// Rstack configuration guide: https://rstack.rs/config
//
// This fixture has NO tool-native config: no `rslint.config.*`, no
// `rstest.config.*`. `rstack.config.ts` is the single config source, and its
// presence alone must light all three stacks — `rs lint` and `rs test` inject
// rstack's own shim configs, so a tool-native file never has to exist.
//
// It sits at the folder root and no `rslint.config.*` exists anywhere, which
// makes this fixture a *bridged folder*: the lint slice's `suite-rstack-bridge`
// asserts what the extension does with it. `define.lint()`'s value IS an Rslint
// flat config — no translation happens anywhere in the chain.
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
