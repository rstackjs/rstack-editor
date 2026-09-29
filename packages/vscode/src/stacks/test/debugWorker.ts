import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createBirpc } from 'birpc';
import vscode from 'vscode';
import { rpcErrorCodec } from './shared/rpc';
import { DEBUG_PIPE_ENV, socketRpc } from './shared/socketRpc';
import type { TestRunReporter } from './testRunReporter';
import type { Worker } from './worker';
import { logger } from './logger';

/** Own the launch session and its local RPC socket as one lifetime. */
export function createDebugWorker(
  reporter: TestRunReporter,
  onClose: () => void,
) {
  const id = randomUUID();
  const directory =
    process.platform === 'win32'
      ? undefined
      : mkdtempSync(path.join(os.tmpdir(), 'rstest-'));
  const endpoint = directory
    ? path.join(directory, 'rpc')
    : `\\\\.\\pipe\\rstest-${id}`;
  const server = net.createServer();
  let socket: net.Socket | undefined;
  let rpc: ReturnType<typeof socketRpc> | undefined;
  let receive: ((data: unknown) => void) | undefined;
  let session: vscode.DebugSession | undefined;
  const ready = Promise.withResolvers<void>();
  // Closing before start() must not produce an unhandled rejection.
  void ready.promise.catch(() => {});
  const subscriptions: vscode.Disposable[] = [];
  let reason: Error | undefined;
  const stop = () => {
    if (session) {
      void vscode.debug.stopDebugging(session).then(undefined, (error) => {
        logger.debug('Failed to stop Rstest debug session', error);
      });
    }
  };
  const worker = createBirpc<Worker, TestRunReporter>(reporter, {
    post: (data) => rpc?.post(data),
    on: (fn) => {
      receive = fn;
    },
    bind: 'functions',
    ...rpcErrorCodec,
    timeout: 600_000,
    off: () => {
      ready.reject(reason ?? new Error('Rstest debug worker stopped'));
      socket?.destroy();
      server.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
      stop();
      for (const disposable of subscriptions) disposable.dispose();
      onClose();
    },
  });
  const fail = (error: Error) => {
    reason ??= error;
    if (!worker.$closed) worker.$close(error);
  };
  server.on('error', fail);
  server.on('connection', (connection) => {
    if (socket) {
      connection.destroy();
      return;
    }
    socket = connection;
    rpc = socketRpc(connection);
    rpc.on((data) => receive?.(data));
    socket.on('error', fail);
    socket.on('close', () =>
      fail(new Error('Rstest debug worker disconnected')),
    );
    ready.resolve();
  });

  return {
    worker,
    async start(
      workspace: vscode.WorkspaceFolder,
      configuration: vscode.DebugConfiguration,
      testRun?: vscode.TestRun,
      token?: vscode.CancellationToken,
    ) {
      const matches = (candidate: vscode.DebugSession) =>
        candidate.configuration.rstestDebugId === id;
      subscriptions.push(
        vscode.debug.onDidStartDebugSession((candidate) => {
          if (!matches(candidate)) return;
          session = candidate;
        }),
        vscode.debug.onDidTerminateDebugSession((candidate) => {
          if (matches(candidate)) fail(new Error('Rstest debug session ended'));
        }),
      );
      if (token)
        subscriptions.push(
          token.onCancellationRequested(() =>
            fail(new Error('Rstest debug run cancelled')),
          ),
        );
      try {
        if (token?.isCancellationRequested) {
          throw new Error('Rstest debug run cancelled');
        }
        server.listen(endpoint);
        const launch = Promise.resolve(
          vscode.debug.startDebugging(
            workspace,
            {
              ...configuration,
              rstestDebugId: id,
              env: { ...configuration.env, [DEBUG_PIPE_ENV]: endpoint },
            },
            { testRun },
          ),
        ).then((started) => {
          if (!started) throw new Error('Failed to launch Rstest debug worker');
        });
        await Promise.all([launch, ready.promise]);
        if (worker.$closed)
          throw new Error('Rstest debug worker stopped during launch');
      } catch (error) {
        fail(error as Error);
        throw error;
      }
    },
  };
}
