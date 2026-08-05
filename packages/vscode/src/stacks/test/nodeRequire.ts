import { createRequire } from 'node:module';

/**
 * A genuine Node `require`, rooted at the emitted bundle.
 *
 * Upstream's `packages/vscode` calls the ambient `require` / `require.resolve`
 * directly. In a bundle those are the bundler's own runtime helpers: a
 * `require(someVariable)` is an expression dependency (rspack warns "the request
 * of a dependency is an expression" and builds a context module over the
 * directory), and `require.resolve(specifier, { paths })` is not the Node API at
 * all. Both are exactly what the `@rstest/core` resolve-from-project path
 * depends on, so the stack goes through `createRequire` instead.
 *
 * `__filename` is the emitted `dist/extension.js` — rspack's `target: 'node'`
 * keeps Node's own value — which is also what `path.resolve(__dirname,
 * 'worker.js')` in `master.ts` relies on. The resolution base only matters for
 * bare-specifier lookups without an explicit `paths`, and every call site here
 * passes `paths`.
 */
export const nodeRequire = createRequire(__filename);
