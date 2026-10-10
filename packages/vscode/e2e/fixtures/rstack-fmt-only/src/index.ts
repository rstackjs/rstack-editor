// A lintable issue that must stay silent until `define.lint()` enables
// `no-debugger` in `rstack.config.ts`.
export function trace(value: unknown): unknown {
  debugger;
  return value;
}
