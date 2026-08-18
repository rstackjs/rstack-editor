import type {
  ActivateConfigsRequest,
  ActivateConfigsResponse,
  ConfigModuleActivationPlan,
  ConfigModuleEslintPluginEntry,
  ConfigModulePluginDescriptor,
  LoadConfigsRequest,
  LoadConfigsResponse,
} from '@rslint/core/config-loader';

interface ConfigActivationWireResponse {
  transactionId: string;
  eslintPluginEntries: ConfigModuleEslintPluginEntry[];
  pluginHostReady: boolean;
}

export interface ConfigTransactionControlRequest {
  protocolVersion: number;
  transactionId: string;
}

interface ConfigCommitWireResponse {
  transactionId: string;
  committed: true;
}

interface ConfigAbortWireResponse {
  transactionId: string;
  aborted: true;
}

interface ConfigModuleHostAdapter {
  loadConfigs(
    request: LoadConfigsRequest,
    signal?: AbortSignal,
  ): Promise<LoadConfigsResponse>;
  activateConfigs(
    request: ActivateConfigsRequest,
    signal?: AbortSignal,
    prepare?: (plan: ConfigModuleActivationPlan) => Promise<void>,
  ): Promise<ActivateConfigsResponse>;
  deleteSession(transactionId: string): boolean;
}

interface PluginLintPoolAdapter {
  prepare(
    descriptors: ConfigModulePluginDescriptor[],
    fingerprint: string,
    generation: string,
  ): Promise<boolean>;
  commit(generation: string): Promise<boolean>;
  abort(generation: string): Promise<void>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('config transaction was cancelled');
}

function assertTransactionControlRequest(
  request: ConfigTransactionControlRequest,
  protocolVersion: number,
): void {
  if (!request || typeof request !== 'object') {
    throw new Error('config transaction request must be an object');
  }
  if (request.protocolVersion !== protocolVersion) {
    throw new Error(
      `unsupported config transaction protocol ${String(request.protocolVersion)}`,
    );
  }
  if (
    typeof request.transactionId !== 'string' ||
    request.transactionId.length === 0
  ) {
    throw new Error('config transactionId must be a non-empty string');
  }
}

/** Hosts one Go config-discovery transaction inside the lint worker. */
export class LspConfigTransactionAdapter {
  private readonly transactions = new Set<string>();
  private disposed = false;

  constructor(
    private readonly host: ConfigModuleHostAdapter,
    private readonly pluginLintPool: PluginLintPoolAdapter,
    private readonly fingerprint: (plan: ConfigModuleActivationPlan) => string,
    private readonly protocolVersion: number,
  ) {}

  async loadConfigs(
    request: LoadConfigsRequest,
    signal?: AbortSignal,
  ): Promise<LoadConfigsResponse> {
    this.assertActive();
    assertTransactionControlRequest(request, this.protocolVersion);
    throwIfAborted(signal);
    const transactionId = request.transactionId;
    this.transactions.add(transactionId);
    try {
      const response = await this.host.loadConfigs(
        { ...request, loadMode: 'fresh' },
        signal,
      );
      this.assertActive();
      throwIfAborted(signal);
      return response;
    } catch (error) {
      this.cleanup(transactionId);
      throw error;
    }
  }

  async activateConfigs(
    request: ActivateConfigsRequest,
    signal?: AbortSignal,
  ): Promise<ConfigActivationWireResponse> {
    this.assertActive();
    assertTransactionControlRequest(request, this.protocolVersion);
    throwIfAborted(signal);
    const transactionId = request.transactionId;
    try {
      let pluginHostReady = false;
      const activation = await this.host.activateConfigs(
        request,
        signal,
        async (candidate) => {
          this.assertActive();
          throwIfAborted(signal);
          pluginHostReady = await this.pluginLintPool.prepare(
            candidate.pluginConfigs,
            this.fingerprint(candidate),
            transactionId,
          );
          this.assertActive();
          throwIfAborted(signal);
        },
      );
      this.assertActive();
      throwIfAborted(signal);
      return {
        transactionId: activation.transactionId,
        eslintPluginEntries: pluginHostReady
          ? activation.eslintPluginEntries
          : [],
        pluginHostReady,
      };
    } catch (error) {
      await this.pluginLintPool.abort(transactionId).catch(() => undefined);
      this.cleanup(transactionId);
      throw error;
    }
  }

  async commitConfigs(
    request: ConfigTransactionControlRequest,
  ): Promise<ConfigCommitWireResponse> {
    this.assertActive();
    assertTransactionControlRequest(request, this.protocolVersion);
    const transactionId = request.transactionId;
    if (!(await this.pluginLintPool.commit(transactionId))) {
      throw new Error(
        `failed to commit plugin-host generation ${JSON.stringify(transactionId)}`,
      );
    }
    this.cleanup(transactionId);
    return { transactionId, committed: true };
  }

  async abortConfigs(
    request: ConfigTransactionControlRequest,
  ): Promise<ConfigAbortWireResponse> {
    assertTransactionControlRequest(request, this.protocolVersion);
    const transactionId = request.transactionId;
    try {
      await this.pluginLintPool.abort(transactionId);
    } finally {
      this.cleanup(transactionId);
    }
    return { transactionId, aborted: true };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const transactionId of this.transactions) {
      this.host.deleteSession(transactionId);
    }
    this.transactions.clear();
  }

  private cleanup(transactionId: string): void {
    this.host.deleteSession(transactionId);
    this.transactions.delete(transactionId);
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('config transaction adapter is disposed');
    }
  }
}
