import { expect, test } from '@rstest/core';

// Discovered through `define.test()` in `rstack.config.ts`, not through an
// `rstest.config.*` file.
test('trims a string', () => {
  expect(' rstack '.trim()).toBe('rstack');
});
