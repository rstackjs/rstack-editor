import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@rstest/core';
import {
  minimalEdit,
  pickConfigDir,
  runRsFmt,
  type RsFmtRun,
} from '../../../src/stacks/fmt/run';
import { createStubRoot, type StubRoot } from './stubProcess';

describe('pickConfigDir', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'rstack-fmt-path-')),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const config = (dir: string): string => path.join(dir, 'rstack.config.ts');

  it('uses the directory of an ancestor config', () => {
    const app = path.join(root, 'app');
    expect(
      pickConfigDir(path.join(app, 'src', 'index.ts'), [config(app)], root),
    ).toBe(app);
  });

  it('uses the deepest ancestor config', () => {
    const app = path.join(root, 'app');
    const nested = path.join(app, 'packages', 'nested');
    expect(
      pickConfigDir(
        path.join(nested, 'src', 'index.ts'),
        [config(app), config(nested)],
        root,
      ),
    ).toBe(nested);
  });

  it('falls back when every config is outside the document tree', () => {
    expect(
      pickConfigDir(
        path.join(root, 'app', 'index.ts'),
        [config(path.join(root, 'other'))],
        root,
      ),
    ).toBe(root);
  });

  it('does not confuse a sibling path prefix for an ancestor', () => {
    expect(
      pickConfigDir(
        path.join(root, 'abc', 'index.ts'),
        [config(path.join(root, 'ab'))],
        root,
      ),
    ).toBe(root);
  });

  it('uses a config next to the document', () => {
    const app = path.join(root, 'app');
    expect(pickConfigDir(path.join(app, 'index.ts'), [config(app)], root)).toBe(
      app,
    );
  });
});

describe('minimalEdit', () => {
  it('returns no edit for identical text', () => {
    expect(minimalEdit('same', 'same')).toBeUndefined();
  });

  it('handles a pure insertion', () => {
    expect(minimalEdit('ac', 'abc')).toEqual({
      start: 1,
      end: 1,
      newText: 'b',
    });
  });

  it('handles a pure deletion', () => {
    expect(minimalEdit('abc', 'ac')).toEqual({
      start: 1,
      end: 2,
      newText: '',
    });
  });

  it('handles a change at the start', () => {
    expect(minimalEdit('old tail', 'new tail')).toEqual({
      start: 0,
      end: 3,
      newText: 'new',
    });
  });

  it('handles a change at the end', () => {
    expect(minimalEdit('head old', 'head new')).toEqual({
      start: 5,
      end: 8,
      newText: 'new',
    });
  });

  it('handles a complete rewrite', () => {
    expect(minimalEdit('abc', 'xyz')).toEqual({
      start: 0,
      end: 3,
      newText: 'xyz',
    });
  });

  it('inserts into an empty original', () => {
    expect(minimalEdit('', 'text')).toEqual({
      start: 0,
      end: 0,
      newText: 'text',
    });
  });

  it('deletes the full original for an empty result', () => {
    expect(minimalEdit('   ', '')).toEqual({
      start: 0,
      end: 3,
      newText: '',
    });
  });

  it('does not overlap the prefix and suffix scans', () => {
    expect(minimalEdit('aa', 'aba')).toEqual({
      start: 1,
      end: 1,
      newText: 'b',
    });
  });

  it('normalizes a CRLF document in one replacement', () => {
    expect(minimalEdit('a\r\nb\r\n', 'a\nb\n')).toEqual({
      start: 1,
      end: 5,
      newText: '\nb',
    });
  });
});

describe('runRsFmt', () => {
  let stubs: StubRoot;

  beforeEach(() => {
    stubs = createStubRoot('run');
  });

  afterEach(() => {
    stubs.remove();
  });

  const writeStub = (source: string): string => stubs.write(source);

  const run = (
    text: string,
    rsBinJs: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<
    ReturnType<typeof runRsFmt> extends Promise<infer T> ? T : never
  > => {
    const options: RsFmtRun = {
      text,
      filePath: path.join(stubs.path, 'input.ts'),
      cwd: stubs.path,
      rsBinJs,
      signal,
    };
    return runRsFmt(options);
  };

  it('captures the complete formatted stdout', async () => {
    const stub = writeStub('process.stdin.pipe(process.stdout);\n');
    await expect(run('const value = 1;\n', stub)).resolves.toEqual({
      kind: 'ok',
      formatted: 'const value = 1;\n',
      stderr: '',
    });
  });

  it('drains stdout while writing a large document', async () => {
    const stub = writeStub('process.stdin.pipe(process.stdout);\n');
    const text = 'x'.repeat(1024 * 1024 + 17);
    await expect(run(text, stub)).resolves.toEqual({
      kind: 'ok',
      formatted: text,
      stderr: '',
    });
  });

  it('returns the stderr tail for a formatter failure', async () => {
    const stub = writeStub(
      "for (let i = 0; i < 12; i++) console.error('line-' + i); process.exit(2);\n",
    );
    const result = await run('broken', stub);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('line-11');
      expect(result.message).not.toContain('line-0');
    }
  });

  it('handles a child exiting without reading stdin', async () => {
    const stub = writeStub('process.exit(2);\n');
    const result = await run('x'.repeat(1024 * 1024), stub);
    expect(result).toEqual({
      kind: 'error',
      message: 'rs fmt exited with code 2',
    });
  });

  it('returns cancelled when aborted mid-run', async () => {
    const stub = writeStub('setTimeout(() => {}, 30_000);\n');
    const controller = new AbortController();
    const resultPromise = run('const value = 1;', stub, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(resultPromise).resolves.toEqual({ kind: 'cancelled' });
  });

  it('does not spawn for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      run(
        'const value = 1;',
        path.join(stubs.path, 'missing.js'),
        controller.signal,
      ),
    ).resolves.toEqual({ kind: 'cancelled' });
  });

  it('names an unloadable rs entry path', async () => {
    const missing = path.join(stubs.path, 'missing.js');
    const result = await run('const value = 1;', missing);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain(missing);
      expect(result.message).toContain('Unable to run rs fmt');
    }
  });
});
