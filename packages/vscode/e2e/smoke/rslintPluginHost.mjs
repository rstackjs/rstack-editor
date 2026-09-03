/**
 * Regression smoke test — "rslint eslint-plugin host path".
 *
 * This is a *verified non-requirement*: with a plain project
 * install of `@rslint/core`, a bare-specifier `import('@rslint/core/eslint-plugin')`
 * → `createPluginLintHost` → `host.lint()` runs the whole pipeline (worker
 * spawned from the sibling `lint-worker.js`, napi parser resolved by walking up
 * `node_modules`, an object-form plugin rule producing a diagnostic, clean
 * shutdown). Nothing rslint-related ships in the VSIX, so if that ever stops
 * being true, this extension's plugin-lint path is dead — hence a regression
 * test rather than a one-off manual verification.
 *
 * It needs no VS Code: it is a plain Node script, run by `pnpm test:e2e:smoke`
 * as well as by the full `pnpm test:e2e`. It deliberately mirrors the
 * extension's own resolution steps (`src/stacks/lint/resolution.ts`):
 *
 *   1. `require.resolve('@rslint/core/package.json', { paths: [projectDir] })`
 *      — the project's install, never this repo's;
 *   2. `createRequire(<that package.json>).resolve('@rslint/core/eslint-plugin')`
 *      — self-reference resolution, pinning the subpath to that same install;
 *   3. the one-resolution-root assertion;
 *   4. a dynamic `import()` of the resolved path — the host is ESM and spawns
 *      its sibling worker via `import.meta.url`, so it can never be `require`d.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(here, '../fixtures/rslint');
const CONFIG_PATH = path.join(PROJECT_DIR, 'rslint.config.mjs');
const SOURCE_PATH = path.join(PROJECT_DIR, 'src/index.ts');
const RULE_NAME = 'local/no-null';

const nodeRequire = createRequire(import.meta.url);

const isInside = (child, parent) => {
  const relative = path.relative(parent, child);
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
};

const main = async () => {
  let corePackageJsonPath;
  try {
    corePackageJsonPath = nodeRequire.resolve('@rslint/core/package.json', {
      paths: [PROJECT_DIR],
    });
  } catch (error) {
    throw new Error(
      `@rslint/core is not installed in the rslint fixture (${PROJECT_DIR}). Run \`pnpm test:e2e:fixtures\` first.`,
      { cause: error },
    );
  }
  const coreDir = path.dirname(corePackageJsonPath);

  const eslintPluginPath = createRequire(corePackageJsonPath).resolve(
    '@rslint/core/eslint-plugin',
  );
  assert.ok(
    isInside(eslintPluginPath, coreDir),
    `one resolution root violated: ${eslintPluginPath} is outside ${coreDir}`,
  );

  console.log(`[smoke] project:        ${PROJECT_DIR}`);
  console.log(`[smoke] @rslint/core:   ${coreDir}`);
  console.log(`[smoke] eslint-plugin:  ${eslintPluginPath}`);

  const logs = [];
  const module = await import(pathToFileURL(eslintPluginPath).href);
  assert.equal(
    typeof module.createPluginLintHost,
    'function',
    `${eslintPluginPath} does not export createPluginLintHost`,
  );

  const host = await module.createPluginLintHost(
    [{ configPath: CONFIG_PATH, configDirectory: PROJECT_DIR }],
    (record) => {
      logs.push(record);
    },
  );

  let result;
  try {
    result = await host.lint({
      // No `text`: the worker reads the file from disk, the path the CLI uses.
      files: [{ path: SOURCE_PATH, configKey: PROJECT_DIR }],
      // The rule set Go would have computed from the config for this file.
      rules: { [RULE_NAME]: { options: [] } },
      collectFixes: false,
      suggestionsMode: 'off',
    });
  } finally {
    await host.shutdown();
  }

  const fileResult = result?.results?.[0];
  assert.ok(fileResult, `no per-file result: ${JSON.stringify(result)}`);
  assert.equal(
    fileResult.parseError,
    undefined,
    `the napi parser failed: ${String(fileResult.parseError)}`,
  );
  assert.deepEqual(
    fileResult.ruleErrors ?? [],
    [],
    `the plugin rule threw: ${JSON.stringify(fileResult.ruleErrors)}`,
  );

  const diagnostics = fileResult.diagnostics ?? [];
  assert.equal(
    diagnostics.length,
    1,
    `expected exactly one ${RULE_NAME} diagnostic, got ${JSON.stringify(diagnostics)}`,
  );
  assert.equal(diagnostics[0].ruleName, RULE_NAME);

  console.log(
    `[smoke] diagnostic:     ${diagnostics[0].ruleName} — ${String(diagnostics[0].message)}`,
  );
  const errors = logs.filter((record) => record.level === 'error');
  assert.deepEqual(errors, [], `host logged errors: ${JSON.stringify(errors)}`);
  console.log(
    '[smoke] OK — project-resolved plugin lint host produced a diagnostic',
  );
};

main().catch((error) => {
  console.error('[smoke] FAILED');
  console.error(error);
  process.exit(1);
});
