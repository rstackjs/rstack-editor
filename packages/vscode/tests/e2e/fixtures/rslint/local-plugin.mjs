/**
 * An object-form ESLint plugin, mounted by `rslint.config.mjs`.
 *
 * Object-form plugin rules run in JS, not in the Go linter: the server sends a
 * reverse `rslint/pluginLint` request back to the client, which answers it from
 * a worker pool owned by `@rslint/core/eslint-plugin`. That is exactly the path
 * the plugin-host regression smoke test exercises, so the rule has to come from a
 * plugin rather than from Rslint's native rule set.
 *
 * `.mjs` on purpose: a `.ts` plugin/config would drag `jiti` (or native type
 * stripping) into a test that is about module resolution, not about config
 * loaders.
 */
export default {
  meta: { name: 'rstack-editor-e2e-local-plugin', version: '1.0.0' },
  rules: {
    'no-null': {
      meta: {
        type: 'suggestion',
        schema: [],
        messages: { unexpected: 'Unexpected `null` literal.' },
      },
      create(context) {
        return {
          Literal(node) {
            if (node.raw === 'null') {
              context.report({ node, messageId: 'unexpected' });
            }
          },
        };
      },
    },
  },
};
