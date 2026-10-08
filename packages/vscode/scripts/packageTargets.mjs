// Builds and packages one platform-targeted VSIX per supported target.
//
// The extension is platform targeted for a single reason: Rstest's AST test
// collection loads the `yuku-parser` napi binding, which `rslib.config.mts`
// stages into `dist/` based on `VSCE_TARGET`.
//
// Packaging a target other than the host platform requires the matching
// optional `@yuku-parser/binding-*` package to be installed locally, e.g.:
//
//   pnpm config set --location=project --json supportedArchitectures \
//     '{"cpu":["current","arm64"]}' && pnpm install
//
// The alpine-* targets need the musl bindings, so also add
// `"libc":["current","musl"]` (and, off Linux, `"os":["current","linux"]`).
//
// CI does exactly that, one runner per target.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const TARGETS = [
  'alpine-arm64',
  'alpine-x64',
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
];

const args = process.argv.slice(2);
const requested = args.filter((arg) => !arg.startsWith('-'));
const all = args.includes('--all');
// Same host detection as `hostVsceTarget()` in rslib.config.mts: musl Linux
// reports no `glibcVersionRuntime` and maps to the alpine-* target.
const hostTarget =
  process.platform === 'linux' &&
  !process.report.getReport().header?.glibcVersionRuntime
    ? `alpine-${process.arch}`
    : `${process.platform}-${process.arch}`;

const targets = all ? TARGETS : requested.length > 0 ? requested : [hostTarget];

for (const target of targets) {
  if (!TARGETS.includes(target)) {
    console.error(
      `Unknown target "${target}". Supported targets: ${TARGETS.join(', ')}`,
    );
    process.exit(1);
  }
}

const run = (command, commandArgs, target) => {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, VSCE_TARGET: target },
  });
  if (result.status !== 0) {
    console.error(
      `\n"${command} ${commandArgs.join(' ')}" failed for ${target}`,
    );
    process.exit(result.status ?? 1);
  }
};

for (const target of targets) {
  console.log(`\n=== packaging ${target} ===`);
  run('rslib', ['build'], target);
  run(
    'vsce',
    ['package', '--target', target, '-o', `rstack-${target}.vsix`],
    target,
  );
}
