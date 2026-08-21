// Materializes a Node.js binary that satisfies the extension's runtime floor
// into .playground/node-bin/, so the F5 playground (see /.vscode/launch.json)
// can prepend it to the Extension Development Host's PATH. A GUI-launched
// VS Code never runs the contributor's shell hooks (fnm/nvm auto-switching on
// the repo's .nvmrc), so without this the dev host inherits whatever `node`
// the desktop session has — often below the floor, and Rslint then refuses to
// start with "version mismatch".
//
// The floor is read from src/shared/versionCheck.ts (NODE_RUNTIME_RANGE), the
// single source of truth — do not restate the range here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const require = createRequire(path.join(packageRoot, 'package.json'));
const semver = require('semver');

const versionCheckSource = fs.readFileSync(
  path.join(packageRoot, 'src', 'shared', 'versionCheck.ts'),
  'utf8',
);
const rangeMatch = versionCheckSource.match(
  /NODE_RUNTIME_RANGE\s*=\s*'([^']+)'/,
);
if (!rangeMatch) {
  throw new Error('Could not read NODE_RUNTIME_RANGE from versionCheck.ts');
}
const floor = rangeMatch[1];

/**
 * One spawn per probed binary: version and executable path together.
 * @returns {{version: string, execPath: string} | undefined}
 */
function probe(binary) {
  try {
    const [version, execPath] = execFileSync(
      binary,
      ['-p', "process.versions.node + '\\n' + process.execPath"],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n');
    const valid = semver.valid(semver.coerce(version));
    return valid ? { version: valid, execPath } : undefined;
  } catch {
    return undefined;
  }
}

function* managedNodeBinaries() {
  const home = os.homedir();
  const exe = process.platform === 'win32' ? 'node.exe' : 'bin/node';
  const roots = [
    // fnm
    process.env.FNM_DIR && path.join(process.env.FNM_DIR, 'node-versions'),
    path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
    path.join(home, '.local', 'share', 'fnm', 'node-versions'),
    path.join(home, '.fnm', 'node-versions'),
    // nvm
    path.join(home, '.nvm', 'versions', 'node'),
    // volta
    path.join(home, '.volta', 'tools', 'image', 'node'),
    // asdf
    path.join(home, '.asdf', 'installs', 'nodejs'),
  ].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Every one of these managers names the install directory after its
      // version, so candidates are filtered without spawning anything.
      const version = semver.valid(semver.coerce(entry));
      if (!version || !semver.satisfies(version, floor)) continue;
      // fnm nests the actual install one level down.
      for (const suffix of [exe, path.join('installation', exe)]) {
        const candidate = path.join(root, entry, suffix);
        if (fs.existsSync(candidate)) yield { binary: candidate, version };
      }
    }
  }
}

/** @returns {{version: string, execPath: string} | undefined} */
function resolveCompliantNode() {
  // A PATH node that already satisfies the floor wins: zero surprise.
  const fromPath = probe('node');
  if (fromPath && semver.satisfies(fromPath.version, floor)) return fromPath;
  // Otherwise the highest satisfying install any common version manager has,
  // confirmed with a single spawn.
  let best;
  for (const candidate of managedNodeBinaries()) {
    if (!best || semver.gt(candidate.version, best.version)) best = candidate;
  }
  return best ? probe(best.binary) : undefined;
}

const target = path.join(packageRoot, '.playground', 'node-bin');
const link = path.join(
  target,
  process.platform === 'win32' ? 'node.exe' : 'node',
);
const resolved = resolveCompliantNode();
if (!resolved) {
  console.error(
    `The playground needs a Node.js satisfying "${floor}" and none was found ` +
      'on PATH or in fnm/nvm/volta/asdf installs. Install one (see .nvmrc), ' +
      'then relaunch.',
  );
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
fs.rmSync(link, { force: true });
try {
  fs.symlinkSync(resolved.execPath, link);
} catch {
  fs.copyFileSync(resolved.execPath, link); // symlinks need privileges on Windows
}
console.log(`playground node: ${resolved.version} (${resolved.execPath})`);
