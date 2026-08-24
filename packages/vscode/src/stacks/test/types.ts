import type { RstestConfig } from '@rstest/core';

//#region master -> worker
export type WorkerInitOptions = RstestConfig & {
  configFilePath: string;
  fileFilters?: string[];
  rstestPath: string;
  command?: 'run' | 'list' | 'watch';
};

/**
 * What the worker answers `getNormalizedConfig` with. A config that fails to
 * evaluate because a dependency is not installed is a result, not a rejection:
 * the IPC channel would strip the error's `code` (see
 * `missingDependencyCauseOf`), so the worker classifies it and reports the
 * loader's own first line as data.
 */
export type NormalizedConfigResult =
  | {
      ok: true;
      root: string;
      include: string[];
      exclude: string[];
      childProjects: { configFilePath: string | null; root: string | null }[];
    }
  | { ok: false; reason: 'missing-dependency'; message: string };
