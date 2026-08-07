import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@rstest/core';
import { FmtStandby, type StandbyKey } from './standby';
import { createStubRoot, type StubRoot } from './stubProcess';

/**
 * The stub scripts stand in for `rs fmt`: they are spawned exactly the way the
 * CLI is, so the tests exercise the real parking, stdin write and exit
 * interpretation rather than a mocked child process (same technique as
 * `run.test.ts`).
 */
describe('FmtStandby', () => {
  let stubs: StubRoot;
  let standbys: FmtStandby[];
  let logs: string[];

  beforeEach(() => {
    stubs = createStubRoot('standby');
    standbys = [];
    logs = [];
  });

  afterEach(() => {
    for (const standby of standbys) {
      standby.dispose();
    }
    stubs.remove();
  });

  const writeStub = (source: string): string => stubs.write(source);
  const echoStub = (): string => stubs.echo();

  const key = (rsBinJs: string, file = 'input.ts'): StandbyKey => ({
    cwd: stubs.path,
    filePath: path.join(stubs.path, file),
    rsBinJs,
  });

  const createStandby = (
    options: { idleTimeoutMs?: number; requestTimeoutMs?: number } = {},
  ): FmtStandby => {
    const standby = new FmtStandby({
      log: (message) => logs.push(message),
      ...options,
    });
    standbys.push(standby);
    return standby;
  };

  const consume = (
    standby: FmtStandby,
    standbyKey: StandbyKey,
    text: string,
    signal: AbortSignal = new AbortController().signal,
  ) => standby.consume(standbyKey, { text, signal });

  const eventually = async (
    probe: () => boolean,
    what: string,
  ): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!probe()) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it('arms a parked process that has not been written to', async () => {
    // The stub only ever prints once it has read stdin, so seeing no output
    // after arming is what "parked" means.
    const stub = writeStub(
      'process.stdin.on("data", () => process.stdout.write("served"));\n',
    );
    const standby = createStandby();
    const armed = key(stub);
    expect(standby.arm(armed)).toBe(true);
    expect(standby.armedFilePath).toBe(armed.filePath);
    expect(logs).toContain(`Standby armed for ${armed.filePath}`);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(standby.armedFilePath).toBe(armed.filePath);
  });

  it('serves the request it was armed for from the parked process', async () => {
    const standby = createStandby();
    const armed = key(echoStub());
    expect(standby.arm(armed)).toBe(true);
    const text = `const value = 1;\n${'x'.repeat(1024 * 64)}\n`;
    await expect(consume(standby, armed, text)).resolves.toEqual({
      kind: 'ok',
      formatted: text,
      stderr: '',
    });
    expect(logs).toContain(`Standby consumed for ${armed.filePath}`);
  });

  it('serves exactly one request', async () => {
    const standby = createStandby();
    const armed = key(echoStub());
    standby.arm(armed);
    await consume(standby, armed, 'const value = 1;\n');
    expect(consume(standby, armed, 'const value = 1;\n')).toBeUndefined();
    expect(standby.armedFilePath).toBeUndefined();
  });

  it('misses when the request key does not match', async () => {
    const standby = createStandby();
    const stub = echoStub();
    const armed = key(stub);
    standby.arm(armed);

    expect(consume(standby, key(stub, 'other.ts'), 'x')).toBeUndefined();
    expect(
      consume(standby, { ...armed, cwd: path.join(stubs.path, 'nested') }, 'x'),
    ).toBeUndefined();
    expect(
      consume(standby, { ...armed, rsBinJs: echoStub() }, 'x'),
    ).toBeUndefined();
    // A miss leaves the standby armed for the file it does match.
    expect(standby.armedFilePath).toBe(armed.filePath);
    await expect(consume(standby, armed, 'x')).resolves.toEqual({
      kind: 'ok',
      formatted: 'x',
      stderr: '',
    });
  });

  it('re-arms on another file by replacing the parked process', () => {
    const standby = createStandby();
    const stub = echoStub();
    standby.arm(key(stub));
    const next = key(stub, 'other.ts');
    expect(standby.arm(next)).toBe(true);
    expect(standby.armedFilePath).toBe(next.filePath);
    expect(logs).toContain(
      'Standby killed (the active editor moved to another file)',
    );
  });

  it('keeps the same process when re-armed for the same key', () => {
    const standby = createStandby();
    const armed = key(echoStub());
    standby.arm(armed);
    expect(standby.arm(armed)).toBe(true);
    expect(
      logs.filter((line) => line.startsWith('Standby armed')),
    ).toHaveLength(1);
  });

  it('kills a parked process on invalidation', () => {
    const standby = createStandby();
    standby.arm(key(echoStub()));
    standby.kill('the config changed');
    expect(standby.armedFilePath).toBeUndefined();
    expect(logs).toContain('Standby killed (the config changed)');
    expect(consume(standby, key(echoStub()), 'x')).toBeUndefined();
  });

  it('discards a parked process that exits on its own', async () => {
    const standby = createStandby();
    const armed = key(writeStub('process.exit(3);\n'));
    expect(standby.arm(armed)).toBe(true);
    await eventually(
      () => standby.armedFilePath === undefined,
      'the parked process to be discarded',
    );
    expect(logs).toContain('Standby killed (the parked process exited)');
    // The next request misses and the caller formats cold.
    expect(consume(standby, armed, 'x')).toBeUndefined();
  });

  it('expires a standby nobody consumed', async () => {
    const standby = createStandby({ idleTimeoutMs: 20 });
    const armed = key(echoStub());
    standby.arm(armed);
    await eventually(
      () => standby.armedFilePath === undefined,
      'the standby to expire',
    );
    expect(logs).toContain('Standby killed (expired after idling)');
    expect(consume(standby, armed, 'x')).toBeUndefined();
  });

  it('does not expire a standby that is serving a request', async () => {
    const standby = createStandby({ idleTimeoutMs: 30 });
    const armed = key(
      writeStub(
        'process.stdin.on("data", (chunk) => setTimeout(() => { process.stdout.write(chunk); process.exit(0); }, 150));\n',
      ),
    );
    standby.arm(armed);
    await expect(consume(standby, armed, 'late')).resolves.toEqual({
      kind: 'ok',
      formatted: 'late',
      stderr: '',
    });
  });

  it('starts the guard timeout at consume, not at arm', async () => {
    const standby = createStandby({ requestTimeoutMs: 100 });
    const stub = writeStub('setTimeout(() => {}, 30_000);\n');
    const armed = key(stub);
    standby.arm(armed);
    // The parked process outlives the guard window before the request starts.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await consume(standby, armed, 'const value = 1;\n');
    expect(result).toEqual({
      kind: 'error',
      message: `rs fmt at ${stub} timed out after 0.1 seconds`,
    });
  });

  it('cancels a hot request and kills its process', async () => {
    const standby = createStandby();
    const armed = key(writeStub('setTimeout(() => {}, 30_000);\n'));
    standby.arm(armed);
    const controller = new AbortController();
    const result = consume(
      standby,
      armed,
      'const value = 1;\n',
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    await expect(result).resolves.toEqual({ kind: 'cancelled' });
  });

  it('reports the CLI verdict for a failing hot request', async () => {
    const standby = createStandby();
    const armed = key(
      writeStub(
        'process.stdin.on("data", () => { console.error("boom"); process.exit(2); });\n',
      ),
    );
    standby.arm(armed);
    await expect(consume(standby, armed, 'broken')).resolves.toEqual({
      kind: 'error',
      message: 'boom',
    });
  });

  it('distinguishes an ignored file from a whitespace-only document', async () => {
    const standby = createStandby();
    const silent = writeStub('process.stdin.resume();\n');
    const ignored = key(silent);
    standby.arm(ignored);
    await expect(
      consume(standby, ignored, 'const value = 1;\n'),
    ).resolves.toEqual({ kind: 'skipped', stderr: '' });

    const blank = key(silent, 'blank.ts');
    standby.arm(blank);
    await expect(consume(standby, blank, '   \n')).resolves.toEqual({
      kind: 'ok',
      formatted: '',
      stderr: '',
    });
  });

  it('does not arm after dispose', () => {
    const standby = createStandby();
    standby.arm(key(echoStub()));
    standby.dispose();
    expect(standby.armedFilePath).toBeUndefined();
    expect(logs).toContain('Standby killed (the fmt stack was disposed)');
    expect(standby.arm(key(echoStub()))).toBe(false);
    expect(standby.armedFilePath).toBeUndefined();
  });

  it('discards a standby whose CLI entry cannot be loaded', async () => {
    const standby = createStandby();
    // The spawn succeeds — node reports an unloadable entry by exiting — so an
    // arm on a broken resolution costs nothing but a debug line.
    const armed = key(path.join(stubs.path, 'missing.js'));
    expect(standby.arm(armed)).toBe(true);
    await eventually(
      () => standby.armedFilePath === undefined,
      'the unloadable standby to be discarded',
    );
    expect(consume(standby, armed, 'x')).toBeUndefined();
  });
});
