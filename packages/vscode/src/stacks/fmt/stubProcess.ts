import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Stub-script scaffolding shared by the fmt unit suites.
 *
 * The suites stand in for `rs fmt` with tiny node scripts spawned exactly the
 * way the CLI is, so they exercise real process behaviour — parking on stdin,
 * back-pressure, EPIPE, exit codes — instead of a mocked child. That technique
 * is load-bearing for both `run.test.ts` and `standby.test.ts`, so it lives
 * here rather than being copied into each.
 *
 * Not a `*.test.ts` file (the runner would collect it as a suite) and not a
 * build entry, so it never ships in the VSIX.
 */
export interface StubRoot {
  /** Temp directory the stubs live in; also used as the spawn cwd. */
  readonly path: string;
  /** Writes a stub script and returns its path. */
  write(source: string): string;
  /** Echoes stdin back, i.e. an `rs fmt` that finds nothing to change. */
  echo(): string;
  remove(): void;
}

export const createStubRoot = (prefix: string): StubRoot => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `rstack-fmt-${prefix}-`)),
  );
  const write = (source: string): string => {
    const filePath = path.join(
      root,
      `rs-${Math.random().toString(16).slice(2)}.js`,
    );
    fs.writeFileSync(filePath, source);
    return filePath;
  };
  return {
    path: root,
    write,
    echo: () => write('process.stdin.pipe(process.stdout);\n'),
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
};
