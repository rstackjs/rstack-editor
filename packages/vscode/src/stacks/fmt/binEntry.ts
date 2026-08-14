/**
 * Where the `rs` CLI entry sits inside a resolved `rstack` package, taken from
 * its package.json `bin` field — npm allows both the string and the object
 * form, and rstack has shipped both.
 *
 * Its own module rather than a function in `index.ts` for the same reason
 * `shared/nodeResolution.ts` keeps its inputs explicit: this is a pure decision
 * over one JSON value, and a unit test for it must not have to stand up a VS
 * Code API stub (importing the stack module evaluates `vscode` and
 * vscode-languageclient).
 */
export const pickBinEntry = (bin: unknown): string => {
  if (typeof bin === 'string') {
    return bin;
  }
  if (
    bin !== null &&
    typeof bin === 'object' &&
    'rs' in bin &&
    typeof bin.rs === 'string'
  ) {
    return bin.rs;
  }
  // What every published rstack has used; a package.json without a usable
  // `bin` is broken either way, and spawning this path produces the clearer
  // failure than resolving to nothing.
  return 'bin/rs.js';
};
