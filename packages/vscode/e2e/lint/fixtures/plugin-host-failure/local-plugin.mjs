import fs from 'node:fs';
import { isMainThread } from 'node:worker_threads';

// Config discovery must succeed; only the plugin-host worker import fails.
// A non-config marker keeps a file-watch refresh or restart from recovering
// the state early; the dependency poll retries the generation.
if (!isMainThread) {
  const state = fs.readFileSync(new URL('./host-state.txt', import.meta.url), 'utf8').trim();
  if (state === 'crash') throw new Error('fixture plugin import exploded');
}

export default {
  rules: {
    report: {
      meta: { type: 'problem', schema: [], messages: { failure: 'Local plugin is running.' } },
      create(context) {
        return { Program(node) { context.report({ node, messageId: 'failure' }); } };
      },
    },
  },
};
