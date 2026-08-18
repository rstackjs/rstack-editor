import { readFileSync } from 'node:fs';
import { defineConfig } from 'bumpp';

// Every package in this repo shares one version (lockstep, like
// rspack-contrib/storybook-rsbuild). `pnpm bump` is therefore a repo-level
// operation, not a per-package script: it rewrites every packages/*/package.json
// in one commit. The VS Code extension is the reference package whose version
// seeds the prompt; the root package.json carries no version on purpose.
const manifest = new URL('./packages/vscode/package.json', import.meta.url);
const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as {
  version: string;
};

export default defineConfig({
  files: ['packages/*/package.json'],
  currentVersion: version,
  commit: 'v%s',
  // Tagging and pushing belong to the release workflow, which tags the commit
  // it actually published from. `pnpm bump` only prepares the release commit
  // for a PR.
  tag: false,
  push: false,
});
