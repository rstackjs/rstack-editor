import { defineConfig } from 'bumpp';

// All packages share one version; see CONTRIBUTING.md → Releasing.
export default defineConfig({
  files: ['packages/*/package.json'],
  commit: 'v%s',
  // Tagging and pushing belong to the release workflow, which tags the commit
  // it actually published from. `pnpm bump` only prepares the release commit
  // for a PR.
  tag: false,
  push: false,
});
