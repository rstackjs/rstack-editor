import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  ActivateConfigsRequest,
  LoadConfigsRequest,
} from '@rslint/core/config-loader';
import type { EslintPluginLintRequest } from '@rslint/core/eslint-plugin';
import {
  createMessageConnection,
  type CancellationToken,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import {
  LspConfigTransactionAdapter,
  type ConfigTransactionControlRequest,
} from './ConfigTransactionAdapter';
import { PluginLintPool } from './PluginLintPool';
import {
  stampConfigRefresh,
  type ConfigRefreshParams,
  type LintWorkerOptions,
} from './cli';
import { loadCoreInstallation } from './core';
import { ActivationFingerprinter } from './fingerprint';
import { logger } from './logger';

const GRACEFUL_EXIT_TIMEOUT_MS = 500;
const FORCED_EXIT_TIMEOUT_MS = 1_500;

interface StopRequest {
  readonly exitCode: number;
  readonly reason: string;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForClose(
  closed: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (closedInTime: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(closedInTime);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void closed.then(() => finish(true));
  });
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>,
): Promise<void> {
  if (!hasExited(child)) child.kill('SIGTERM');
  if (await waitForClose(closed, GRACEFUL_EXIT_TIMEOUT_MS)) return;
  if (!hasExited(child)) child.kill('SIGKILL');
  if (await waitForClose(closed, FORCED_EXIT_TIMEOUT_MS)) return;
  throw new Error(
    `Rslint process ${String(child.pid)} did not exit after SIGKILL`,
  );
}

async function spawnRslint(
  binaryPath: string,
): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(binaryPath, ['--lsp'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.stderr.pipe(process.stderr, { end: false });
  return child;
}

async function withCancellationSignal<T>(
  token: CancellationToken,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  const subscription = token.onCancellationRequested(() => {
    controller.abort();
  });
  try {
    return await operation(controller.signal);
  } finally {
    subscription.dispose();
  }
}

function forwardNotification(
  target: MessageConnection,
  method: string,
  params: unknown,
  requestStop: (request: StopRequest) => void,
): void {
  const forwarded =
    params === undefined
      ? target.sendNotification(method)
      : target.sendNotification(method, params);
  void forwarded.catch((error: unknown) => {
    logger.error(`Failed to forward notification ${method}`, error);
    requestStop({ exitCode: 1, reason: `notification ${method} failed` });
  });
}

function forwardRequest(
  target: MessageConnection,
  method: string,
  params: unknown,
  token: CancellationToken,
): Promise<unknown> {
  return params === undefined
    ? target.sendRequest(method, token)
    : target.sendRequest(method, params, token);
}

interface EditorProxyOptions {
  readonly protocolVersion: number;
  readonly configPath?: string;
  observeRefresh(reason: unknown): void;
  requestStop(request: StopRequest): void;
}

export function registerEditorProxy(
  editorConnection: MessageConnection,
  goConnection: MessageConnection,
  options: EditorProxyOptions,
): void {
  editorConnection.onRequest(async (method, params, token) => {
    if (method === 'rslint/configRefresh') {
      const refresh = params as ConfigRefreshParams;
      options.observeRefresh(refresh?.reason);
      return goConnection.sendRequest(
        method,
        stampConfigRefresh(
          refresh,
          options.protocolVersion,
          options.configPath,
        ),
        token,
      );
    }
    return forwardRequest(goConnection, method, params, token);
  });
  editorConnection.onNotification((method, params) => {
    forwardNotification(goConnection, method, params, options.requestStop);
  });
}

export async function runLintWorker(
  options: LintWorkerOptions,
): Promise<number> {
  const installation = await loadCoreInstallation(options.coreDir);
  logger.info(
    `Loaded @rslint/core ${installation.version} from ${installation.packageDirectory}`,
  );
  const child = await spawnRslint(installation.binaryPath);
  const childClosed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });

  const editorConnection = createMessageConnection(
    process.stdin,
    process.stdout,
    logger,
  );
  const goConnection = createMessageConnection(
    child.stdout,
    child.stdin,
    logger,
  );
  const fingerprinter = new ActivationFingerprinter(process.cwd());
  const pluginLintPool = new PluginLintPool(
    logger,
    installation.createPluginLintHost,
  );
  const adapter = new LspConfigTransactionAdapter(
    installation.createConfigModuleHost(),
    pluginLintPool,
    (activation) => fingerprinter.compute(activation),
    installation.protocolVersion,
  );

  const stop = deferred<StopRequest>();
  let stopping = false;
  const requestStop = (request: StopRequest): void => {
    if (stopping) return;
    stopping = true;
    logger.debug(`Stopping lint worker: ${request.reason}`);
    stop.resolve(request);
  };

  registerEditorProxy(editorConnection, goConnection, {
    protocolVersion: installation.protocolVersion,
    configPath: options.configPath,
    observeRefresh: (reason) => fingerprinter.observeRefresh(reason),
    requestStop,
  });

  goConnection.onRequest(async (method, params, token) => {
    switch (method) {
      case 'rslint/loadConfigs':
        return withCancellationSignal(token, async (signal) =>
          adapter.loadConfigs(params as LoadConfigsRequest, signal),
        );
      case 'rslint/activateConfigs':
        return withCancellationSignal(token, async (signal) =>
          adapter.activateConfigs(params as ActivateConfigsRequest, signal),
        );
      case 'rslint/commitConfigs':
        return adapter.commitConfigs(params as ConfigTransactionControlRequest);
      case 'rslint/abortConfigs':
        return adapter.abortConfigs(params as ConfigTransactionControlRequest);
      case 'rslint/pluginLint':
        return pluginLintPool.lint(params as EslintPluginLintRequest, token);
      default:
        return forwardRequest(editorConnection, method, params, token);
    }
  });
  goConnection.onNotification((method, params) => {
    forwardNotification(editorConnection, method, params, requestStop);
  });

  editorConnection.onClose(() => {
    requestStop({ exitCode: 0, reason: 'editor transport closed' });
  });
  goConnection.onClose(() => {
    requestStop({
      exitCode: child.exitCode ?? 1,
      reason: 'Rslint transport closed',
    });
  });
  child.once('close', (code) => {
    requestStop({
      exitCode: code ?? 1,
      reason: `Rslint exited with code ${String(code)}`,
    });
  });
  process.once('SIGINT', () => {
    requestStop({ exitCode: 0, reason: 'received SIGINT' });
  });
  process.once('SIGTERM', () => {
    requestStop({ exitCode: 0, reason: 'received SIGTERM' });
  });

  goConnection.listen();
  editorConnection.listen();
  const result = await stop.promise;

  adapter.dispose();
  await pluginLintPool.dispose();
  editorConnection.dispose();
  goConnection.dispose();
  await terminateChild(child, childClosed);
  return result.exitCode;
}
