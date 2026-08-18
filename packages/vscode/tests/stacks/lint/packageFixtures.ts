/**
 * Throwaway `node_modules` layouts for the lint resolution tests. Every path
 * handed back is a real path, so identity assertions do not trip over
 * `/tmp` → `/private/tmp` on macOS.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporaryDirectories: string[] = [];

export function temporaryDirectory(prefix = 'rslint-'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return fs.realpathSync(directory);
}

/** Call from `afterEach`. */
export function removeTemporaryDirectories(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function writePackage(
  directory: string,
  name: 'rstack' | '@rslint/core',
  version: string,
): string {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, version }),
  );
  return directory;
}

export function installPackage(
  root: string,
  name: 'rstack' | '@rslint/core',
  version: string,
): string {
  return writePackage(
    path.join(root, 'node_modules', ...name.split('/')),
    name,
    version,
  );
}

/** rstack's published `dist/rslintConfig.js`, the bridged folder's shim. */
export function installShim(rstackDirectory: string): string {
  const shimPath = path.join(rstackDirectory, 'dist', 'rslintConfig.js');
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  fs.writeFileSync(shimPath, 'module.exports = [];');
  return shimPath;
}
