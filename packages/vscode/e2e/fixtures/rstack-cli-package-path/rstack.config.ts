// Rstack configuration guide: https://rstack.rs/config
//
// The #103 layout: this config sits at the workspace folder root, but
// `rstack` is installed only under `infra/`, where no `node_modules` walk-up
// from the root can see it. `.vscode/settings.json` points
// `rstack.rstackCli.packagePath` at that installation, which must light all
// three stacks. The E2E harness copies the fixture out of this repository first,
// so the repository's own `node_modules/rstack` cannot satisfy the walk-up.
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
  name: 'rstack-editor-fixture-rstack-cli-package-path',
  include: ['tests/**/*.test.ts'],
});
