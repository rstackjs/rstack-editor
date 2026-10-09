// Lints every document outside `packages/legacy` through the lint bridge. The
// glob deliberately matches nested files too, so a nested document handed to
// the bridged runtime by mistake would report `no-debugger`.
import { define } from 'rstack';

define.lint([
  {
    files: ['**/*.ts'],
    rules: {
      'no-debugger': 'error',
    },
  },
]);
