// Preloaded via a `--import` node arg whose `pkg` query carries the
// configured package.json path (why: `rstackResolveHookArgs` in
// `rstackPackage.ts`).
// Resolves `rstack` and `rstack/*` as if from inside the configured package,
// through its own `exports`; every other specifier passes through. Plain JS,
// copied to `dist/` by `rslib.config.mts`: Node loads it outside the bundle.
import nodeModule from 'node:module';
import { pathToFileURL } from 'node:url';

const packageJson = new URL(import.meta.url).searchParams.get('pkg');

if (packageJson) {
  const anchorURL = pathToFileURL(packageJson).href;
  const requireFromPackage = nodeModule.createRequire(packageJson);
  let inside = false;

  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        inside ||
        !(specifier === 'rstack' || specifier.startsWith('rstack/'))
      ) {
        return nextResolve(specifier, context);
      }
      if (context.conditions?.includes('require')) {
        // The CJS default resolver ignores a rewritten parentURL, so ask the
        // package's own require() instead. On Node 22 and Node 24 below 24.15
        // `require.resolve` (jiti's path) never reaches this hook at all.
        inside = true;
        let filename;
        try {
          filename = requireFromPackage.resolve(specifier);
        } finally {
          inside = false;
        }
        return { url: pathToFileURL(filename).href, shortCircuit: true };
      }
      return nextResolve(specifier, { ...context, parentURL: anchorURL });
    },
  });
}
