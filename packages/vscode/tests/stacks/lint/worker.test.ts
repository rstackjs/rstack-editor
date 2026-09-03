import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from '@rstest/core';
import { createMessageConnection, NullLogger } from 'vscode-jsonrpc/node';
import {
  LINT_WORKER_USAGE,
  parseWorkerArgs,
  stampConfigRefresh,
} from '../../../src/stacks/lint/worker/cli';
import { registerEditorProxy } from '../../../src/stacks/lint/worker/index';

const fakeGoSource = String.raw`
let buffer = Buffer.alloc(0);

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(
    'Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body,
  );
}

function handle(message) {
  if (message.method === 'exit') {
    process.exit(0);
  }
  if (message.id === undefined) return;
  const hasParams = Object.prototype.hasOwnProperty.call(message, 'params');
  send({
    jsonrpc: '2.0',
    id: message.id,
    result: {
      method: message.method,
      hasParams,
      ...(hasParams ? { params: message.params } : {}),
    },
  });
}

function readMessages() {
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length: (\d+)/i.exec(header);
    if (!match) process.exit(2);
    const contentLength = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) return;
    const body = buffer.subarray(bodyStart, bodyEnd).toString('utf8');
    buffer = buffer.subarray(bodyEnd);
    handle(JSON.parse(body));
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  readMessages();
});
`;

describe('lint worker CLI', () => {
  it('accepts only absolute core and optional config paths', () => {
    const coreDir = path.resolve('/project/node_modules/@rslint/core');
    const configPath = path.resolve(
      '/project/node_modules/rstack/dist/config.js',
    );
    expect(parseWorkerArgs(['--lsp', '--core', coreDir])).toEqual({ coreDir });
    expect(
      parseWorkerArgs(['--lsp', '--core', coreDir, '--config', configPath]),
    ).toEqual({ coreDir, configPath });
  });

  it('rejects unknown, missing and relative arguments', () => {
    for (const args of [
      [],
      ['--core', '/core', '--lsp'],
      ['--lsp', '--core', './core'],
      ['--lsp', '--core', '/core', '--other', '/config'],
    ]) {
      expect(() => parseWorkerArgs(args)).toThrow();
    }
    expect(LINT_WORKER_USAGE).toContain('--lsp --core');
  });
});

describe('lint worker config refresh', () => {
  it('stamps the core protocol and pins the explicit shim on every refresh', () => {
    const configPath = path.resolve('/project/rslintConfig.js');
    for (const reason of ['initial', 'config-change', 'dependency-change']) {
      expect(stampConfigRefresh({ reason }, 3, configPath)).toEqual({
        protocolVersion: 3,
        reason,
        configPath,
      });
    }
  });

  it('leaves native discovery without an explicit config path', () => {
    expect(stampConfigRefresh({ reason: 'initial' }, 3)).toEqual({
      protocolVersion: 3,
      reason: 'initial',
    });
  });

  it('stamps requests sent to Go and preserves parameterless messages', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-worker-go-'));
    const stubPath = path.join(directory, 'fake-go.cjs');
    fs.writeFileSync(stubPath, fakeGoSource);
    const child = spawn(process.execPath, [stubPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const childClosed = new Promise<number | null>((resolve) => {
      child.once('close', resolve);
    });
    const editorToWorker = new PassThrough();
    const workerToEditor = new PassThrough();
    const editorConnection = createMessageConnection(
      workerToEditor,
      editorToWorker,
      NullLogger,
    );
    const workerConnection = createMessageConnection(
      editorToWorker,
      workerToEditor,
      NullLogger,
    );
    const goConnection = createMessageConnection(
      child.stdout,
      child.stdin,
      NullLogger,
    );
    const configPath = path.resolve('/project/rslintConfig.js');
    const observedReasons: unknown[] = [];

    try {
      registerEditorProxy(workerConnection, goConnection, {
        protocolVersion: 3,
        configPath,
        observeRefresh: (reason) => observedReasons.push(reason),
        requestStop: () => undefined,
      });
      goConnection.listen();
      workerConnection.listen();
      editorConnection.listen();

      const refresh = await editorConnection.sendRequest<{
        readonly method: string;
        readonly hasParams: boolean;
        readonly params: Record<string, unknown>;
      }>('rslint/configRefresh', { reason: 'config-change' });
      expect(refresh).toEqual({
        method: 'rslint/configRefresh',
        hasParams: true,
        params: {
          protocolVersion: 3,
          reason: 'config-change',
          configPath,
        },
      });
      expect(observedReasons).toEqual(['config-change']);

      const shutdown = await editorConnection.sendRequest<{
        readonly method: string;
        readonly hasParams: boolean;
      }>('shutdown');
      expect(shutdown).toEqual({ method: 'shutdown', hasParams: false });

      await editorConnection.sendNotification('exit');
      expect(await childClosed).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await childClosed;
      }
      editorConnection.dispose();
      workerConnection.dispose();
      goConnection.dispose();
      editorToWorker.destroy();
      workerToEditor.destroy();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
