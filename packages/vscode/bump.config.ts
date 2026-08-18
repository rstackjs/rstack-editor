import { defineConfig } from 'bumpp';

// Invoked through the root `pnpm bump` fan-out; bumps this package's manifest
// only. Tagging and pushing belong to the release workflow, which tags the
// commit it actually published from — `pnpm bump` only prepares the release
// commit for a PR.
export default defineConfig({
  files: ['package.json'],
  commit: 'v%s',
  tag: false,
  push: false,
});
