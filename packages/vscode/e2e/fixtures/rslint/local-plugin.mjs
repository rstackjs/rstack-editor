/**
 * An object-form ESLint plugin, mounted by `rslint.config.mjs`.
 *
 * Object-form plugin rules run in the project's own plugin runtime, so this
 * rule has to come from a plugin rather than from the built-in rule set. That
 * is exactly the path the plugin-host regression smoke test exercises.
 *
 * `.mjs` on purpose: a `.ts` plugin/config would drag `jiti` (or native type
 * stripping) into a test that is about module resolution, not about loading
 * TypeScript configs.
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
