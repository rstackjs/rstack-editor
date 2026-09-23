import { pathToFileURL } from 'node:url';
import { createBirpc } from 'birpc';
import { missingDependencyCauseOf } from '../../../shared/missingDependency';
import { SUPPORT_MATRIX } from '../../../shared/versionCheck';
import type { TestRunReporter } from '../testRunReporter';
import type { NormalizedConfigResult, WorkerInitOptions } from '../types';
import { retractForceColorIfDisabled } from '../shared/colorEnv';
import { rpcErrorCodec } from '../shared/rpc';
import { logger } from './logger';
import { CoverageReporter, ProgressLogger, ProgressReporter } from './reporter';

type ActiveWatcher = { close(): Promise<void> };

// fix ESM import path issue on windows
// Only URLs with a scheme in: file, data, and node are supported by the default ESM loader.
const normalizeImportPath = (path: string) => pathToFileURL(path).toString();

export class Worker {
  private activeOneShotRun?: Promise<void>;
  private watcher?: ActiveWatcher;
  private watcherClosePromise?: Promise<void>;
  private watcherStartupPromise?: Promise<ActiveWatcher>;

  private async init({
    apiPath,
    configFilePath,
    fileFilters,
    rstestPath,
    command = 'run',
    ...overrideConfig
  }: WorkerInitOptions) {
    const coreModule = (await import(
      normalizeImportPath(rstestPath)
    )) as typeof import('@rstest/core');
    const apiModule: Partial<typeof import('@rstest/core/api')> = await import(
      normalizeImportPath(apiPath)
    );
    if (typeof apiModule.createRstest !== 'function') {
      throw new Error(
        `@rstest/core at ${apiPath} does not export createRstest from "./api"; this extension requires @rstest/core ${SUPPORT_MATRIX['@rstest/core']}`,
      );
    }
    logger.debug('Loaded Rstest module');
    const { loadConfig, mergeRstestConfig } = coreModule;
    const { createRstest } = apiModule;

    const loaded = await loadConfig({ path: configFilePath });
    // The config may have set NO_COLOR just now — the CLI's own decision
    // point is also right after config load (adaptation #9, colorEnv.ts).
    retractForceColorIfDisabled(process.env);
    const config = mergeRstestConfig(loaded.content, {
      ...overrideConfig,
      reporters: [
        ['default', { logger: new ProgressLogger() }],
        new ProgressReporter(),
      ],
      coverage: {
        ...loaded.content.coverage,
        ...overrideConfig.coverage,
      },
    });
    const rstest = await createRstest({
      config: { content: config, filePath: loaded.filePath },
    });
    return { rstest, fileFilters, command };
  }

  public async getNormalizedConfig(
    options: WorkerInitOptions,
  ): Promise<NormalizedConfigResult> {
    // The core loads outside the classified region: a broken `@rstest/core`
    // install failing to import is the real error to report, not "the config
    // imports an uninstalled package". Once this import succeeds, `init()`'s
    // own import of the same path is served from the module cache.
    await import(normalizeImportPath(options.rstestPath));
    try {
      const { rstest } = await this.init(options);
      const { config } = rstest.context;
      return {
        ok: true,
        root: rstest.context.rootPath,
        include: config.include,
        exclude: config.exclude.patterns,
        // Sub-projects this config aggregates via `projects`. Empty for a leaf
        // config. The extension uses these to avoid registering a child config
        // as its own top-level project when a parent already covers it
        // (otherwise the same test files show up twice). A file-based child is
        // identified by its config file; inline children only have a root.
        // `null` (not `undefined`) so the fields survive the IPC JSON round-trip.
        childProjects: rstest.context.projects.map((project) => ({
          configFilePath: project.configFilePath ?? null,
          root: project.rootPath,
        })),
      };
    } catch (error) {
      // Classified here and not in the master: `code` does not survive the
      // IPC round-trip. Only this unprompted, per-config evaluation gets the
      // treatment — a run or list the user asked for reports its failure.
      const cause = missingDependencyCauseOf(error);
      if (cause !== undefined) return { ok: false, message: cause };
      throw error;
    }
  }

  public runTest(data: WorkerInitOptions): Promise<void> {
    const operation = this.executeTestRun(data);
    if (data.command === 'watch') return operation;
    this.activeOneShotRun = operation;
    const clear = () => {
      if (this.activeOneShotRun === operation)
        this.activeOneShotRun = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async executeTestRun(data: WorkerInitOptions): Promise<void> {
    logger.debug('Received runTest request', JSON.stringify(data, null, 2));
    try {
      const { rstest, fileFilters, command } = await this.init({
        ...data,
        coverage: data.coverage?.enabled
          ? { ...data.coverage, reporters: [new CoverageReporter()] }
          : data.coverage,
      });
      const runOptions = { filters: fileFilters } satisfies NonNullable<
        Parameters<typeof rstest.run>[0]
      >;
      if (command === 'watch') {
        const startup = rstest.watch(runOptions);
        this.watcherStartupPromise = startup;
        try {
          this.watcher = await startup;
          this.watcherClosePromise = undefined;
          logger.debug('Test run completed', { result: this.watcher });
          return;
        } finally {
          if (this.watcherStartupPromise === startup) {
            this.watcherStartupPromise = undefined;
          }
        }
      }
      const result = await rstest.run(runOptions);
      if (result.status === 'error') {
        throw new Error(
          result.unhandledErrors.map((error) => error.message).join('\n\n'),
        );
      }
      if (
        result.status === 'fail' &&
        result.summary.tests.failed === 0 &&
        result.summary.files.failed === 0
      ) {
        throw new Error(
          'Rstest run failed without test-level failures. Check for operation-level failures such as coverage report errors or unmet coverage thresholds.',
        );
      }
      logger.debug('Test run completed', { result });
    } catch (error) {
      logger.error('Test run failed', error);
      throw error;
    }
  }

  public async closeWatcher(): Promise<void> {
    if (this.activeOneShotRun) {
      try {
        await this.activeOneShotRun;
      } catch {
        // The runTest RPC owns reporting operation failures. Graceful shutdown
        // only waits for the run's executor and teardown to settle.
      }
    }
    let watcher = this.watcher;
    if (!watcher && this.watcherStartupPromise) {
      try {
        watcher = await this.watcherStartupPromise;
      } catch {
        return;
      }
    }
    if (!watcher) return;
    this.watcherClosePromise ??= watcher.close().finally(() => {
      this.watcher = undefined;
    });
    await this.watcherClosePromise;
  }

  public async listTests(data: WorkerInitOptions) {
    const { rstest, fileFilters } = await this.init({
      ...data,
      command: 'list',
    });
    const filterOptions = { filters: fileFilters };
    const declarations = await rstest.listTests({
      ...filterOptions,
      includeSuites: true,
      includeTaskLocation: true,
    });
    // A second call rebuilds the list engine, including planner/config/glob work.
    // Filtered refreshes are covered by the caller's requestedFiles seed.
    if (fileFilters) return declarations;
    const files = await rstest.listTests({ ...filterOptions, filesOnly: true });
    return [...files, ...declarations];
  }
}

const worker = new Worker();
export const masterApi = createBirpc<TestRunReporter, Worker>(worker, {
  post: (data) => process.send?.(data),
  on: (fn) => process.on('message', fn),
  bind: 'functions',
  ...rpcErrorCodec,
});

if (process.argv[1] === __filename) {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    // The master owns the 30-second grace period and uses SIGKILL if it expires.
    // Once SIGTERM arrives, wait for the same idempotent close instead of
    // truncating an in-flight teardown with a second one-second deadline.
    shutdownPromise ??= worker
      .closeWatcher()
      .catch((error) =>
        logger.error('Failed to close the active watcher', error),
      )
      .finally(() => process.exit());
  };
  process.once('disconnect', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
