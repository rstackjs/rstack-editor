// Copied from web-infra-dev/rslint `packages/vscode-extension/src/Rslint.ts`
// and adapted so the extension host is only the language-client half. Project
// config evaluation and plugin rules run in the editor-shipped lint worker.

import path from 'node:path';
import {
  Disposable,
  type FileSystemWatcher,
  type OutputChannel,
  RelativePattern,
  type TextDocument,
  Uri,
  workspace,
  type WorkspaceFolder,
  env,
} from 'vscode';
import {
  CloseAction,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ErrorAction,
  LanguageClient,
  type LanguageClientOptions,
  type ErrorHandler,
  type Middleware,
  type ServerOptions,
  State,
} from 'vscode-languageclient/node';
import {
  configuredNodeBelowFloor,
  NodePreflightError,
  resolveUserNodeOnce,
} from '../../shared/nodeResolution';
import { getConfiguredNodeExecutable } from '../../shared/nodeExecutableSetting';
import type { StackState } from '../../types';
import type { CoreInstallation } from './CoreResolver';
import { LanguageServerProcessOwner } from './LanguageServerProcessOwner';
import type { Logger } from './logger';
import type { RslintMode } from './resolution';
import {
  RslintVersionMismatchError,
  runningRslintStatus,
  statusForRslintStartFailure,
} from './status';
import {
  createWorkspaceDocumentSelector,
  type WorkspaceDocumentRouter,
} from './WorkspaceDocumentRouter';

/**
 * Bound for each wait inside `close()`. Covers a warm worker boot (~1s), and
 * is what a changed-key replacement or deactivation pays, worst case, for a
 * hung start (the superseded close is awaited on the per-document tail).
 */
const CLOSE_SETTLEMENT_TIMEOUT_MS = 2_000;

const LOCKFILE_NAMES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
] as const;

const RSLINT_CONFIG_WATCH_NAMES = [
  'rslint.config.js',
  'rslint.config.mjs',
  'rslint.config.ts',
  'rslint.config.mts',
] as const;

export const CONFIG_REFRESH_WATCH_GLOB = `**/{${[
  ...RSLINT_CONFIG_WATCH_NAMES,
  ...LOCKFILE_NAMES,
].join(',')}}`;

/** Kept separate to avoid the nested-brace glob shape VS Code cannot parse. */
export const RSTACK_CONFIG_REFRESH_WATCH_GLOB = 'rstack.config.{ts,js,mts,mjs}';

export type ConfigRefreshReason =
  'initial' | 'config-change' | 'dependency-change';

export type ConfigRefreshRequester = (
  reason: ConfigRefreshReason,
) => Promise<void>;

export function recoverConfigDiscoveryOnServerState(
  newState: State,
  requestConfigRefresh: ConfigRefreshRequester,
): Promise<void> | undefined {
  if (newState !== State.Running) return undefined;
  return requestConfigRefresh('initial');
}

export function shouldResetDocumentSessionOnServerState(
  oldState: State,
  newState: State,
): boolean {
  return oldState === State.Running && newState !== State.Running;
}

export function createLanguageClientOptions(
  workspaceFolder: WorkspaceFolder,
  outputChannel: OutputChannel | undefined,
  traceOutputChannel: OutputChannel,
  middleware?: Middleware,
): LanguageClientOptions {
  const documentSelector = createWorkspaceDocumentSelector(workspaceFolder);
  return {
    workspaceFolder,
    documentSelector:
      // rslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      documentSelector as unknown as LanguageClientOptions['documentSelector'],
    outputChannel,
    // vscode-languageclient reads rstack.rslint.trace.server and owns its
    // initial and live $/setTrace updates. Supplying this unconditionally
    // ensures enabling tracing after startup uses the shared Rslint channel.
    // The setting is window-scoped because the client reads it without a URI.
    traceOutputChannel,
    middleware,
  };
}

export function configRefreshReasonForPath(
  filePath: string,
): Exclude<ConfigRefreshReason, 'initial'> {
  return (LOCKFILE_NAMES as readonly string[]).includes(path.basename(filePath))
    ? 'dependency-change'
    : 'config-change';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isConfigSourceChangeDuringTransaction(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return (
    error.code === 'CONFIG_CHANGED_DURING_LOAD' ||
    (typeof error.message === 'string' &&
      error.message.includes('config changed while'))
  );
}

export async function retryConfigRefreshOnSourceChange(
  initial: () => Promise<void>,
  retry: () => Promise<void>,
): Promise<boolean> {
  try {
    await initial();
    return false;
  } catch (error) {
    if (!isConfigSourceChangeDuringTransaction(error)) throw error;
    await retry();
    return true;
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Rslint workspace start was cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export interface LanguageClientCloseTarget {
  readonly state: State;
  readonly diagnostics: Disposable | undefined;
  dispose(): Promise<void>;
}

export class ManagedLanguageClient extends LanguageClient {
  public override async start(): Promise<void> {
    const outerStart = super.start();
    if (this.state !== State.Starting) return outerStart;

    // languageclient v9 keeps a shared start promise behind its public async
    // start() call. A transport close during initialize clears the private
    // reference before the outer call adopts it, leaving its rejection
    // unobserved. A second, idempotent call adopts that shared promise now.
    const sharedStart = super.start();
    void outerStart.catch(() => undefined);
    return sharedStart;
  }

  public override async stop(timeout?: number): Promise<void> {
    const stateBeforeStop = this.state;
    try {
      await super.stop(timeout);
    } catch (error) {
      if (stateBeforeStop === State.Running) throw error;
    }
  }
}

export async function disposeLanguageClient(
  client: LanguageClientCloseTarget,
): Promise<void> {
  const diagnostics = client.diagnostics;
  const reportDisposeFailure = client.state === State.Running;
  const errors: unknown[] = [];
  try {
    await client.dispose();
  } catch (error) {
    if (reportDisposeFailure) errors.push(error);
  }
  try {
    diagnostics?.dispose();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'failed to dispose language client');
  }
}

export async function waitForPromiseSettlement(
  promise: Promise<unknown>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (!settled) {
      throw new Error(`${description} did not settle within ${timeoutMs}ms`);
    }
  } finally {
    clearTimeout(timer);
  }
}

interface ClientStoppedObservation {
  readonly promise: Promise<void>;
  dispose(): void;
}

function observeClientStopped(
  client: LanguageClient,
): ClientStoppedObservation {
  if (client.state === State.Stopped) {
    return { promise: Promise.resolve(), dispose: () => undefined };
  }
  let subscription: Disposable | undefined;
  const promise = new Promise<void>((resolve) => {
    subscription = client.onDidChangeState((event) => {
      if (event.newState === State.Stopped) resolve();
    });
  });
  return {
    promise,
    dispose() {
      subscription?.dispose();
      subscription = undefined;
    },
  };
}

export type RslintStatusSink = (state: StackState) => void;

export interface RslintOptions {
  readonly rootKey: string;
  readonly workspaceFolder: WorkspaceFolder;
  /**
   * The one Rslint core this runtime serves, already resolved and version
   * gated by `CoreResolver`. Upstream passes loaded module factories here; we
   * pass paths, because the host never loads project code (ADR 0003).
   */
  readonly installation: CoreInstallation;
  readonly outputChannel: OutputChannel;
  readonly lspOutputChannel: OutputChannel;
  readonly router: WorkspaceDocumentRouter;
  readonly logger: Logger;
  readonly reportStatus: RslintStatusSink;
  readonly onClosed?: () => void;
}

export class Rslint implements Disposable {
  private client: LanguageClient | undefined;
  private readonly logger: Logger;
  public readonly rootKey: string;
  public readonly workspaceFolder: WorkspaceFolder;
  private readonly router: WorkspaceDocumentRouter;
  private readonly reportStatus: RslintStatusSink;
  private readonly installation: CoreInstallation;
  private readonly lspOutputChannel: OutputChannel;
  private readonly outputChannel: OutputChannel;
  private readonly onClosed: (() => void) | undefined;
  private readonly configWatchers: FileSystemWatcher[] = [];
  private configReloadTimer: ReturnType<typeof setTimeout> | undefined;
  private configReloadChain: Promise<void> = Promise.resolve();
  private serverRestartWatcher: Disposable | undefined;
  private serverProcessOwner: LanguageServerProcessOwner | undefined;
  private stateWatcher: Disposable | undefined;
  private lifecycleEpoch = 0;
  private advisory: string | undefined;
  private startPromise: Promise<void> | undefined;
  private startOperation: Promise<void> | undefined;
  private clientStartPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closing = false;

  constructor(options: RslintOptions) {
    this.rootKey = options.rootKey;
    this.workspaceFolder = options.workspaceFolder;
    this.router = options.router;
    this.reportStatus = options.reportStatus;
    this.installation = options.installation;
    this.logger = options.logger;
    this.lspOutputChannel = options.lspOutputChannel;
    this.outputChannel = options.outputChannel;
    this.onClosed = options.onClosed;
  }

  private report(state: StackState): void {
    this.reportStatus(state);
  }

  private reportRunning(): void {
    this.report(runningRslintStatus(this.advisory));
  }

  public async start(signal: AbortSignal): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    if (this.closing || signal.aborted) throw abortError(signal);
    this.startOperation = this.startImpl(signal).catch((error: unknown) => {
      this.reportStartFailure(error);
      throw error;
    });
    this.startPromise = raceWithAbort(this.startOperation, signal);
    void this.startOperation.catch(() => undefined);
    await this.startPromise;
  }

  private isPlannedStartAbort(error: unknown): boolean {
    return (
      this.closing || (error instanceof Error && error.name === 'AbortError')
    );
  }

  private reportStartFailure(error: unknown): void {
    if (this.isPlannedStartAbort(error)) return;
    this.report(statusForRslintStartFailure(error));
  }

  private async startImpl(signal: AbortSignal): Promise<void> {
    this.configReloadChain = Promise.resolve();
    this.lifecycleEpoch++;
    const epoch = this.lifecycleEpoch;
    this.advisory = undefined;
    this.report({ kind: 'starting' });

    const folderRoot = this.workspaceFolder.uri.fsPath;
    const { mode, packageDirectory, shimPath } = this.installation;

    this.logger.info(
      `Rslint ${mode} mode: @rslint/core ${this.installation.version ?? 'unknown'} at ${packageDirectory}`,
    );
    if (shimPath !== undefined) {
      this.logger.info(`Rstack lint shim: ${shimPath}`);
    }

    const nodeExecutable = await this.resolveNodeExecutable();
    this.assertStartCurrent(epoch, signal);
    const workerPath = path.resolve(__dirname, 'lint-worker.js');
    const workerArgs = [workerPath, '--lsp', '--core', packageDirectory];
    if (shimPath !== undefined) {
      workerArgs.push('--config', shimPath);
    }
    const serverProcessOwner = new LanguageServerProcessOwner(
      nodeExecutable,
      workerArgs,
      folderRoot,
    );
    this.serverProcessOwner = serverProcessOwner;
    const serverOptions: ServerOptions = async () => serverProcessOwner.start();

    const clientOptions = createLanguageClientOptions(
      this.workspaceFolder,
      this.outputChannel,
      this.lspOutputChannel,
      this.router.createMiddleware(this),
    );
    const errorHandlerHolder: { current?: ErrorHandler } = {};
    clientOptions.errorHandler = {
      error: async (error, message, count) =>
        Promise.resolve(
          errorHandlerHolder.current?.error(error, message, count) ?? {
            action: ErrorAction.Shutdown,
          },
        ),
      closed: async () => {
        if (this.closing) {
          return { action: CloseAction.DoNotRestart, handled: true };
        }
        return Promise.resolve(
          errorHandlerHolder.current?.closed() ?? {
            action: CloseAction.DoNotRestart,
          },
        );
      },
    };
    const client = new ManagedLanguageClient(
      'rstack.rslint',
      `Rslint Language Server (${this.workspaceFolder.name})`,
      serverOptions,
      clientOptions,
    );
    errorHandlerHolder.current = client.createDefaultErrorHandler();
    this.client = client;
    this.stateWatcher = client.onDidChangeState((event) => {
      this.logger.debug(
        `Language client state ${event.oldState} -> ${event.newState}`,
      );
      if (this.closing || client !== this.client) return;
      if (event.newState === State.Stopped) {
        this.report({
          kind: 'crashed',
          detail: 'the Rslint language server stopped',
        });
      } else if (event.newState === State.Running) {
        this.reportRunning();
      }
    });

    try {
      const clientStartPromise = client.start();
      this.clientStartPromise = clientStartPromise;
      await clientStartPromise;
      this.assertStartCurrent(epoch, signal, client);

      this.serverRestartWatcher = client.onDidChangeState((event) => {
        if (
          shouldResetDocumentSessionOnServerState(
            event.oldState,
            event.newState,
          )
        ) {
          void this.router.resetServerSession(this).catch((error: unknown) => {
            this.logger.error(
              'Failed to reset documents after server exit',
              error,
            );
          });
        }
        const recovery = recoverConfigDiscoveryOnServerState(
          event.newState,
          async (reason) => {
            await this.router.resetServerSession(this);
            await this.requestConfigRefresh(reason);
          },
        );
        recovery?.then(
          () => {
            this.logger.info(
              'Documents and config discovery recovered after server restart',
            );
          },
          (error: unknown) => {
            this.logger.error('Failed to recover after server restart', error);
          },
        );
      });

      this.installConfigRefreshWatchers(mode);
      const retried = await retryConfigRefreshOnSourceChange(
        async () => this.requestConfigRefresh('initial'),
        async () => this.requestConfigRefresh('config-change'),
      );
      this.assertStartCurrent(epoch, signal, client);
      if (retried) {
        this.logger.warn(
          'Config changed during initial activation; discovery recovered on retry',
        );
      }
      this.logger.info('Rslint language client started successfully');
      this.reportRunning();
    } catch (error: unknown) {
      // A close or supersede during start is a planned abort, not a failure;
      // logging it as an error made every teardown race look like a crash.
      if (!this.isPlannedStartAbort(error)) {
        this.logger.error('Failed to start Rslint language client', error);
      }
      throw error;
    }
  }

  private async resolveNodeExecutable(): Promise<string> {
    const configured = getConfiguredNodeExecutable(this.workspaceFolder);
    if (configured !== undefined) {
      void configuredNodeBelowFloor(configured).then((message) => {
        if (message !== undefined && !this.closing) {
          this.advisory = message;
          if (this.isRunning()) this.reportRunning();
        }
      });
      return configured;
    }
    try {
      const resolution = await resolveUserNodeOnce({
        shell: env.shell || undefined,
        cwd: this.workspaceFolder.uri.fsPath,
        notify: (message) => this.logger.info(message),
      });
      return resolution.executable;
    } catch (error) {
      if (error instanceof NodePreflightError) {
        throw new RslintVersionMismatchError(
          error.messageWith('Rslint will not lint'),
        );
      }
      throw error;
    }
  }

  private assertStartCurrent(
    epoch: number,
    signal: AbortSignal,
    client?: LanguageClient,
  ): void {
    throwIfAborted(signal);
    if (
      this.closing ||
      epoch !== this.lifecycleEpoch ||
      (client !== undefined && client !== this.client)
    ) {
      throw abortError(signal);
    }
  }

  private installConfigRefreshWatchers(mode: RslintMode): void {
    const patterns = [
      CONFIG_REFRESH_WATCH_GLOB,
      ...(mode === 'bridged' ? [RSTACK_CONFIG_REFRESH_WATCH_GLOB] : []),
    ];
    const refreshConfig = (uri: Uri) => {
      const reason = configRefreshReasonForPath(uri.fsPath);
      this.logger.debug(`${reason}: ${uri.fsPath}`);
      clearTimeout(this.configReloadTimer);
      this.configReloadTimer = setTimeout(() => {
        this.configReloadTimer = undefined;
        void this.requestConfigRefresh(reason).catch((error: unknown) => {
          this.logger.error('Failed to refresh config discovery', error);
        });
      }, 300);
    };
    for (const pattern of patterns) {
      const watcher = workspace.createFileSystemWatcher(
        new RelativePattern(this.workspaceFolder, pattern),
      );
      this.configWatchers.push(watcher);
      watcher.onDidChange(refreshConfig);
      watcher.onDidCreate(refreshConfig);
      watcher.onDidDelete(refreshConfig);
    }
  }

  private async requestConfigRefresh(
    reason: ConfigRefreshReason,
  ): Promise<void> {
    const epoch = this.lifecycleEpoch;
    const client = this.client;
    if (!client) return;
    const refresh = this.configReloadChain.then(async () => {
      if (!this.isLifecycleCurrent(epoch, client)) return;
      await client.sendRequest('rslint/configRefresh', { reason });
    });
    this.configReloadChain = refresh.catch(() => undefined);
    await refresh;
  }

  private isLifecycleCurrent(epoch: number, client: LanguageClient): boolean {
    return (
      epoch === this.lifecycleEpoch && client === this.client && !this.closing
    );
  }

  public async close(): Promise<void> {
    await (this.closePromise ??= this.closeImpl());
  }

  private async closeImpl(): Promise<void> {
    try {
      await this.closeResources();
    } finally {
      this.onClosed?.();
    }
  }

  private async closeResources(): Promise<void> {
    const errors: unknown[] = [];
    const disposeSafely = (resource: Disposable | undefined): void => {
      if (!resource) return;
      try {
        resource.dispose();
      } catch (error) {
        errors.push(error);
      }
    };

    this.closing = true;
    this.lifecycleEpoch++;
    clearTimeout(this.configReloadTimer);
    this.configReloadTimer = undefined;
    disposeSafely(this.serverRestartWatcher);
    this.serverRestartWatcher = undefined;
    for (const watcher of this.configWatchers.splice(0)) {
      disposeSafely(watcher);
    }
    disposeSafely(this.stateWatcher);
    this.stateWatcher = undefined;
    this.configReloadChain = Promise.resolve();

    const client = this.client;
    this.client = undefined;
    const clientStartPromise = this.clientStartPromise;
    this.clientStartPromise = undefined;
    // Severing the transport under an in-flight initialize makes
    // vscode-languageclient force-notify ("couldn't create connection to
    // server" / "Server initialization failed"), so a Starting client gets a
    // bounded chance to settle first — a successful start then stops cleanly,
    // a hung one falls through to the hard teardown.
    if (client?.state === State.Starting && clientStartPromise) {
      await waitForPromiseSettlement(
        clientStartPromise,
        CLOSE_SETTLEMENT_TIMEOUT_MS,
        'language client start before teardown',
      ).catch(() => undefined);
    }
    const clientStopped =
      client?.state === State.Starting
        ? observeClientStopped(client)
        : undefined;
    const serverProcessOwner = this.serverProcessOwner;
    this.serverProcessOwner = undefined;
    serverProcessOwner?.beginClose();

    const asynchronousCleanups: Promise<void>[] = [];
    if (client) {
      asynchronousCleanups.push(
        (async () => {
          const clientErrors: unknown[] = [];
          try {
            await disposeLanguageClient(client);
          } catch (error) {
            clientErrors.push(error);
          }
          try {
            await serverProcessOwner?.close();
          } catch (error) {
            clientErrors.push(error);
          }
          if (clientStopped) {
            try {
              await waitForPromiseSettlement(
                clientStopped.promise,
                CLOSE_SETTLEMENT_TIMEOUT_MS,
                'language client terminal state',
              );
            } catch (error) {
              clientErrors.push(error);
            } finally {
              clientStopped.dispose();
            }
          }
          if (clientErrors.length > 0) {
            throw new AggregateError(
              clientErrors,
              'failed to close language client resources',
            );
          }
        })(),
      );
    } else if (serverProcessOwner) {
      asynchronousCleanups.push(serverProcessOwner.close());
    }
    const results = await Promise.allSettled(asynchronousCleanups);
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    for (const error of errors) {
      this.logger.error('Failed to close Rslint workspace resource', error);
    }
    if (errors.length === 0) {
      this.logger.info('Rslint language client closed');
    }
    this.logger.dispose();
    if (errors.length > 0) {
      throw new AggregateError(errors, 'failed to close Rslint workspace');
    }
  }

  public isRunning(): boolean {
    return this.client?.state === State.Running;
  }

  public serverAdvertisesHover(): boolean {
    return Boolean(this.client?.initializeResult?.capabilities.hoverProvider);
  }

  public async sendDocumentOpen(document: TextDocument): Promise<void> {
    const provider = this.client
      ?.getFeature(DidOpenTextDocumentNotification.method)
      .getProvider(document);
    if (!provider) {
      throw new Error(`didOpen provider is unavailable for ${document.uri}`);
    }
    await provider.send(document);
  }

  public async sendDocumentClose(document: TextDocument): Promise<void> {
    const provider = this.client
      ?.getFeature(DidCloseTextDocumentNotification.method)
      .getProvider(document);
    if (!provider) {
      throw new Error(`didClose provider is unavailable for ${document.uri}`);
    }
    await provider.send(document);
  }

  public clearDocumentDiagnostics(uri: Uri): void {
    this.client?.diagnostics?.delete(uri);
  }

  public dispose(): void {
    void this.close().catch(() => undefined);
  }
}
