/**
 * Regression smoke test — "rslint eslint-plugin host path".
 *
 * This is a *verified non-requirement*: with a plain project install of
 * `@rslint/core`, a bare-specifier `import('@rslint/core/eslint-plugin')`
 * resolves to the project's own copy and exports `createPluginLintHost`, and
 * the full plugin pipeline runs (Go projects each file's ESTree frame, the
 * host's sibling `lint-worker.js` answers the reverse `pluginLint` request,
 * the native byte transport resolves by walking up `node_modules`, an
 * object-form plugin rule produces a diagnostic, clean shutdown). Nothing
 * rslint-related ships in the VSIX, so if that ever stops being true, this
 * extension's plugin-lint path is dead — hence a regression test rather than
 * a one-off manual verification.
 *
 * It needs no VS Code: it is a plain Node script, run by `pnpm test:e2e:smoke`
 * as well as by the full `pnpm test:e2e`. It deliberately mirrors the
 * extension's own resolution steps (`src/stacks/lint/resolution.ts`):
 *
 *   1. `require.resolve('@rslint/core/package.json', { paths: [projectDir] })`
 *      — the project's install, never this repo's;
 *   2. `createRequire(<that package.json>).resolve(...)` for both the package
 *      entry and `@rslint/core/eslint-plugin` — self-reference resolution,
 *      pinning both subpaths to that same install;
 *   3. the one-resolution-root assertion;
 *   4. dynamic `import()`es of the resolved paths — the host is ESM and spawns
 *      its sibling worker via `import.meta.url`, so it can never be `require`d.
 *
 * Since `@rslint/core` 0.10.0 Go projects the ESTree frame itself and the host
 * only consumes it (`EslintPluginLintRequest.files[].frame` is required), so a
 * hand-built `host.lint()` request with just a path is no longer a valid
 * request. Driving the pipeline through the public `Rslint` class exercises
 * the same reverse `pluginLint` request — real frames included — against the
 * entry asserted below, and keeps this test valid across core versions.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(here, '../fixtures/rslint');
const SOURCE_PATTERN = 'src/index.ts';
const RULE_NAME = 'local/no-null';
const RULE_MESSAGE_ID = 'unexpected';

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
  const projectRequire = createRequire(corePackageJsonPath);

  const coreEntryPath = projectRequire.resolve('@rslint/core');
  assert.ok(
    isInside(coreEntryPath, coreDir),
    `one resolution root violated: ${coreEntryPath} is outside ${coreDir}`,
  );
  const eslintPluginPath = projectRequire.resolve('@rslint/core/eslint-plugin');
  assert.ok(
    isInside(eslintPluginPath, coreDir),
    `one resolution root violated: ${eslintPluginPath} is outside ${coreDir}`,
  );

  console.log(`[smoke] project:        ${PROJECT_DIR}`);
  console.log(`[smoke] @rslint/core:   ${coreDir}`);
  console.log(`[smoke] eslint-plugin:  ${eslintPluginPath}`);

  const coreModule = await import(pathToFileURL(coreEntryPath).href);
  assert.equal(
    typeof coreModule.Rslint,
    'function',
    `${coreEntryPath} does not export Rslint`,
  );

  const pluginModule = await import(pathToFileURL(eslintPluginPath).href);
  assert.equal(
    typeof pluginModule.createPluginLintHost,
    'function',
    `${eslintPluginPath} does not export createPluginLintHost`,
  );

  let results;
  const rslint = new coreModule.Rslint({ cwd: PROJECT_DIR });
  try {
    results = await rslint.lintFiles(SOURCE_PATTERN);
  } finally {
    await rslint.close();
  }

  const fileResult = results?.[0];
  assert.ok(fileResult, `no per-file result: ${JSON.stringify(results)}`);

  const messages = fileResult.messages ?? [];
  const fatal = messages.filter((message) => message.fatal);
  assert.deepEqual(
    fatal,
    [],
    `the linter failed fatally: ${JSON.stringify(fatal)}`,
  );

  // `local/no-null` is an object-form plugin rule: Go cannot run it, so this
  // diagnostic proves the project install's plugin host answered the reverse
  // request with a Go-projected frame. The VS Code `eslintPlugins` E2E suite
  // covers the same path through the extension's own worker.
  const diagnostics = messages.filter(
    (message) => message.ruleId === RULE_NAME,
  );
  assert.equal(
    diagnostics.length,
    1,
    `expected exactly one ${RULE_NAME} diagnostic, got ${JSON.stringify(messages)}`,
  );
  assert.equal(diagnostics[0].messageId, RULE_MESSAGE_ID);

  console.log(
    `[smoke] diagnostic:     ${diagnostics[0].ruleId} — ${String(diagnostics[0].message)} (${diagnostics[0].line}:${diagnostics[0].column})`,
  );
  console.log(
    '[smoke] OK — project-resolved plugin lint host produced a diagnostic',
  );
};

main().catch((error) => {
  console.error('[smoke] FAILED');
  console.error(error);
  process.exit(1);
});
