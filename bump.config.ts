import { readFileSync } from 'node:fs';
import { defineConfig } from 'bumpp';

// The VS Code extension is the only versioned artifact in this repo: its
// manifest version is what the release workflow publishes and tags. The root
// package.json carries no version on purpose.
const manifest = new URL('./packages/vscode/package.json', import.meta.url);
const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as {
  version: string;
};

export default defineConfig({
  files: ['packages/vscode/package.json'],
  currentVersion: version,
  commit: 'chore(vscode): release v%s',
  // Tagging and pushing belong to the release workflow, which tags the commit
  // it actually published from. `pnpm bump` only prepares the release commit
  // for a PR.
  tag: false,
  push: false,
});
