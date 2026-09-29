import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createBirpc } from 'birpc';
import vscode from 'vscode';
import { rpcErrorCodec } from './shared/rpc';
import { socketRpc } from './shared/socketRpc';
import type { TestRunReporter } from './testRunReporter';
import type { Worker } from './worker';
import { logger } from './logger';

export const DEBUG_PIPE_ENV = 'RSTACK_RSTEST_DEBUG_PIPE';

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
  let receive: ((data: unknown) => void) | undefined;
  let session: vscode.DebugSession | undefined;
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<never>();
  // Closing before start() must not produce an unhandled rejection.
  void ready.promise.catch(() => {});
  void closed.promise.catch(() => {});
  const subscriptions: vscode.Disposable[] = [];
  let timer: NodeJS.Timeout | undefined;
  let cleanedUp = false;
  const stop = () => {
    if (session) {
      void vscode.debug.stopDebugging(session).then(undefined, (error) => {
        logger.debug('Failed to stop Rstest debug session', error);
      });
    }
  };
  const worker = createBirpc<Worker, TestRunReporter>(reporter, {
    post: (data) => socket && socketRpc(socket).post(data),
    on: (fn) => {
      receive = fn;
    },
    bind: 'functions',
    ...rpcErrorCodec,
    timeout: 600_000,
    off: () => {
      // birpc invokes off even when $close is called more than once.
      if (cleanedUp) return;
      cleanedUp = true;
      if (timer) clearTimeout(timer);
      ready.reject(new Error('Rstest debug worker stopped before connecting'));
      closed.reject(new Error('Rstest debug worker stopped'));
      socket?.destroy();
      server.close(() => {
        if (directory) rmdirSync(directory);
      });
      stop();
      for (const disposable of subscriptions) disposable.dispose();
      onClose();
    },
  });
  const fail = (error: Error) => {
    ready.reject(error);
    closed.reject(error);
    if (!worker.$closed) worker.$close(error);
  };
  server.on('error', fail);
  server.on('connection', (connection) => {
    if (socket || worker.$closed) {
      connection.destroy();
      return;
    }
    socket = connection;
    socketRpc(socket).on((data) => receive?.(data));
    socket.on('error', fail);
    socket.on('close', () =>
      fail(new Error('Rstest debug worker disconnected')),
    );
    if (timer) clearTimeout(timer);
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
        candidate.configuration.rstestDebugId === id &&
        !candidate.parentSession;
      subscriptions.push(
        vscode.debug.onDidStartDebugSession((candidate) => {
          if (!matches(candidate)) return;
          session = candidate;
          if (worker.$closed) stop();
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
        if (worker.$closed || token?.isCancellationRequested) {
          throw new Error('Rstest debug run cancelled');
        }
        await Promise.race([
          new Promise<void>((resolve) => server.listen(endpoint, resolve)),
          closed.promise,
        ]);
        if (worker.$closed) throw new Error('Rstest debug run cancelled');
        timer = setTimeout(
          () => fail(new Error('Timed out starting Rstest debug worker')),
          30_000,
        );
        // Keep the start listener alive until the launch request settles: a
        // cancelled launch can still publish its session afterwards.
        const lateStart = vscode.debug.onDidStartDebugSession((candidate) => {
          if (matches(candidate) && worker.$closed) {
            void vscode.debug.stopDebugging(candidate);
          }
        });
        const launch = Promise.resolve()
          .then(() =>
            vscode.debug.startDebugging(
              workspace,
              {
                ...configuration,
                rstestDebugId: id,
                env: { ...configuration.env, [DEBUG_PIPE_ENV]: endpoint },
              },
              { testRun },
            ),
          )
          .then((started) => {
            if (!started)
              throw new Error('Failed to launch Rstest debug worker');
          })
          .finally(() => lateStart.dispose());
        await Promise.race([
          Promise.all([launch, ready.promise]),
          closed.promise,
        ]);
        if (worker.$closed)
          throw new Error('Rstest debug worker stopped during launch');
      } catch (error) {
        fail(error as Error);
        throw error;
      }
    },
  };
}
