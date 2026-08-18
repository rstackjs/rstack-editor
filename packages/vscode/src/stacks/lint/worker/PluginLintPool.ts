import type {
  ConfigDescriptor,
  EslintPluginLintRequest,
  EslintPluginLintResult,
  PluginLintHost,
} from '@rslint/core/eslint-plugin';
import type { CancellationToken } from 'vscode-jsonrpc/node';
import type { WorkerLogger } from './logger';

export type PluginHostFactory = (
  configs: ConfigDescriptor[],
  onLog: (record: { level: string; source: string; text: string }) => void,
) => Promise<PluginLintHost>;

const MAX_GRACE_GENERATIONS = 1;

export class PluginLintPool {
  private readonly generations = new Map<string, HostGeneration>();
  private readonly generationRetirementTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private activeGeneration: string | undefined;
  private activeState: HostGeneration | undefined;
  private activeCommitRollback: ActiveCommitRollback | undefined;
  private readonly liveStates = new Set<HostGeneration>();
  private readonly shutdowns = new Set<Promise<void>>();
  private opChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly logger: WorkerLogger,
    private readonly createHost: PluginHostFactory,
    private readonly retirementDelayMs = 30_000,
  ) {}

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.opChain.then(operation, operation);
    this.opChain = run.catch(() => undefined);
    return run;
  }

  async prepare(
    descriptors: ConfigDescriptor[],
    fingerprint: string,
    generation: string,
  ): Promise<boolean> {
    let ready = false;
    await this.enqueue(async () => {
      if (this.disposed || generation === '') return;

      const existing = this.generations.get(generation);
      if (existing) {
        ready = existing.ready;
        return;
      }

      if (
        this.activeState?.ready &&
        this.activeState.fingerprint === fingerprint
      ) {
        this.generations.set(generation, this.activeState);
        ready = true;
        return;
      }

      if (descriptors.length === 0) {
        const state: HostGeneration = {
          fingerprint,
          ready: true,
          activeLints: 0,
          retiring: false,
        };
        this.liveStates.add(state);
        this.generations.set(generation, state);
        ready = true;
        return;
      }

      try {
        const replacement = await this.createHost(descriptors, (record) => {
          const text = `[rslint:plugin] ${record.text}`;
          if (record.level === 'error') this.logger.error(text);
          else this.logger.debug(text);
        });
        if (this.disposed) {
          await replacement.shutdown().catch(() => undefined);
          return;
        }
        const state: HostGeneration = {
          fingerprint,
          host: replacement,
          ready: true,
          activeLints: 0,
          retiring: false,
        };
        this.liveStates.add(state);
        this.generations.set(generation, state);
        ready = true;
      } catch (error: unknown) {
        const state: HostGeneration = {
          fingerprint,
          ready: false,
          activeLints: 0,
          retiring: false,
        };
        this.liveStates.add(state);
        this.generations.set(generation, state);
        this.logger.error('Failed to initialize ESLint-plugin host', error);
      }
    });
    return ready;
  }

  async commit(generation: string): Promise<boolean> {
    let committed = false;
    await this.enqueue(async () => {
      if (this.disposed) return;
      const next = this.generations.get(generation);
      if (!next) return;
      if (generation === this.activeGeneration) {
        committed = true;
        return;
      }

      const previousGeneration = this.activeGeneration;
      const previous = this.activeState;
      this.finalizeActiveCommitRollback();
      if (previousGeneration) {
        this.cancelGenerationRetirement(previousGeneration);
      }
      this.activeGeneration = generation;
      this.activeState = next;
      this.activeCommitRollback = {
        generation,
        previousGeneration,
        previousState: previous,
      };
      committed = true;
    });
    return committed;
  }

  async abort(generation: string): Promise<void> {
    await this.enqueue(async () => {
      if (generation === this.activeGeneration) {
        const rollback = this.activeCommitRollback;
        if (!rollback || rollback.generation !== generation) return;
        const aborted = this.activeState;
        this.activeGeneration = rollback.previousGeneration;
        this.activeState = rollback.previousState;
        this.activeCommitRollback = undefined;
        if (rollback.previousGeneration) {
          this.cancelGenerationRetirement(rollback.previousGeneration);
        }
        this.generations.delete(generation);
        if (
          aborted &&
          aborted !== this.activeState &&
          !this.hasGenerationReference(aborted)
        ) {
          this.retire(aborted);
        }
        return;
      }
      const state = this.generations.get(generation);
      if (!state) return;
      this.generations.delete(generation);
      if (state !== this.activeState && !this.hasGenerationReference(state)) {
        this.retire(state);
      }
    });
  }

  async lint(
    request: EslintPluginLintRequest,
    token?: CancellationToken,
  ): Promise<EslintPluginLintResult> {
    if (this.disposed) return { results: [] };

    let state = request.generation
      ? this.generations.get(request.generation)
      : this.activeState;
    if (request.generation && !state) {
      if (!(await this.waitForLifecycle(token))) return { results: [] };
      if (this.disposed) return { results: [] };
      state = this.generations.get(request.generation);
    }
    if (request.generation && !state) {
      throw new Error(
        `unknown ESLint-plugin config generation: ${request.generation}`,
      );
    }
    if (!state) return { results: [] };
    const host = state.host;
    if (!host) {
      if (token?.isCancellationRequested) return { results: [] };
      const generation = request.generation ?? this.activeGeneration;
      throw new Error(
        `LSP pluginLint requested for config generation ${JSON.stringify(generation)} without an activated plugin host`,
      );
    }

    state.activeLints++;
    let signal: AbortSignal | undefined;
    let cancellationSubscription: { dispose(): unknown } | undefined;
    try {
      if (token) {
        const controller = new AbortController();
        if (token.isCancellationRequested) controller.abort();
        else {
          cancellationSubscription = token.onCancellationRequested(() => {
            controller.abort();
          });
        }
        signal = controller.signal;
      }
      return await host.lint(request, signal);
    } finally {
      cancellationSubscription?.dispose();
      state.activeLints--;
      if (state.retiring && state.activeLints === 0) {
        this.startShutdown(state);
      }
    }
  }

  private async waitForLifecycle(token?: CancellationToken): Promise<boolean> {
    const pending = this.opChain;
    if (!token) {
      await pending;
      return true;
    }
    if (token.isCancellationRequested) return false;

    let cancellationSubscription: { dispose(): unknown } | undefined;
    const cancelled = new Promise<false>((resolve) => {
      cancellationSubscription = token.onCancellationRequested(() => {
        resolve(false);
      });
    });
    try {
      return await Promise.race([pending.then(() => true as const), cancelled]);
    } finally {
      cancellationSubscription?.dispose();
    }
  }

  private hasGenerationReference(state: HostGeneration): boolean {
    for (const candidate of this.generations.values()) {
      if (candidate === state) return true;
    }
    return false;
  }

  private retire(state: HostGeneration): void {
    state.retiring = true;
    if (state.activeLints === 0) this.startShutdown(state);
  }

  private finalizeActiveCommitRollback(): void {
    const rollback = this.activeCommitRollback;
    if (!rollback) return;
    this.activeCommitRollback = undefined;
    if (rollback.previousGeneration) {
      this.scheduleGenerationRetirement(
        rollback.previousGeneration,
        rollback.previousState,
      );
    }
  }

  private cancelGenerationRetirement(generation: string): void {
    const timer = this.generationRetirementTimers.get(generation);
    if (!timer) return;
    clearTimeout(timer);
    this.generationRetirementTimers.delete(generation);
  }

  private scheduleGenerationRetirement(
    generation: string,
    state: HostGeneration | undefined,
  ): void {
    const existing = this.generationRetirementTimers.get(generation);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.completeGenerationRetirement(generation, state);
    }, this.retirementDelayMs);
    this.generationRetirementTimers.set(generation, timer);

    while (this.generationRetirementTimers.size > MAX_GRACE_GENERATIONS) {
      const oldest = this.generationRetirementTimers.keys().next().value;
      if (oldest === undefined) break;
      this.completeGenerationRetirement(oldest, this.generations.get(oldest));
    }
  }

  private completeGenerationRetirement(
    generation: string,
    state: HostGeneration | undefined,
  ): void {
    const timer = this.generationRetirementTimers.get(generation);
    if (!timer) return;
    clearTimeout(timer);
    this.generationRetirementTimers.delete(generation);
    if (this.activeGeneration === generation) return;
    if (this.generations.get(generation) !== state) return;

    this.generations.delete(generation);
    if (
      state &&
      state !== this.activeState &&
      !this.hasGenerationReference(state)
    ) {
      this.retire(state);
    }
  }

  private startShutdown(state: HostGeneration): void {
    if (state.shutdown) return;
    for (const [generation, candidate] of this.generations) {
      if (candidate === state) {
        this.generations.delete(generation);
        const timer = this.generationRetirementTimers.get(generation);
        if (timer) clearTimeout(timer);
        this.generationRetirementTimers.delete(generation);
      }
    }
    const shutdown = state.host
      ? state.host.shutdown().catch((error: unknown) => {
          this.logger.error('Error shutting down previous plugin host', error);
        })
      : Promise.resolve();
    state.shutdown = shutdown;
    this.shutdowns.add(shutdown);
    void shutdown.finally(() => {
      this.shutdowns.delete(shutdown);
      this.liveStates.delete(state);
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.enqueue(async () => {
      const states = [...this.liveStates];
      this.generations.clear();
      for (const timer of this.generationRetirementTimers.values()) {
        clearTimeout(timer);
      }
      this.generationRetirementTimers.clear();
      this.activeGeneration = undefined;
      this.activeState = undefined;
      this.activeCommitRollback = undefined;
      for (const state of states) this.startShutdown(state);
    });
    await Promise.all([...this.shutdowns]);
  }
}

interface HostGeneration {
  fingerprint: string;
  host?: PluginLintHost;
  ready: boolean;
  activeLints: number;
  retiring: boolean;
  shutdown?: Promise<void>;
}

interface ActiveCommitRollback {
  generation: string;
  previousGeneration: string | undefined;
  previousState: HostGeneration | undefined;
}
