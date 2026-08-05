import { expect, test } from '@rstest/core';

// Trivial on purpose: the fixture exists to be *discovered*, so the test tree
// has something to show. What it asserts is irrelevant.
test('adds two numbers', () => {
  expect(1 + 1).toBe(2);
});
