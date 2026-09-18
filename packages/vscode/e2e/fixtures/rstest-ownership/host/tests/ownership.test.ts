import path from 'node:path';
import { expect, test } from '@rstest/core';
import { value } from '@host-value';

test('uses the nested config and cwd', () => {
  expect(value).toBe('nested-config');
  expect(process.cwd()).toBe(path.resolve(__dirname, '..'));
});
