// The lintable issue this fixture exists for: the `null` literal below is
// reported by `local/no-null` (see `rslint.config.mjs`). Exactly one `null`
// literal — the smoke test asserts on the diagnostic count.
export function getValue() {
  return null;
}
