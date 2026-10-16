// A lintable issue for the `no-debugger` rule configured through
// `define.lint()` in `rstack.config.ts`.
export function trace(value: unknown): unknown {
  debugger;
  return value;
}
