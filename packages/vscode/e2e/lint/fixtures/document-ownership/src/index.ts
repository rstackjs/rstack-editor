// Violates both `no-debugger` (root rstack.config.ts) and `no-empty` (nested
// rslint.config.ts); which one reports shows which config owns this file.
export function check(value: boolean): boolean {
  debugger;
  if (value) {
  }
  return value;
}
