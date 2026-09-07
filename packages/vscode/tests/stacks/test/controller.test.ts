import { beforeEach, describe, expect, it, rs } from '@rstest/core';
import { status } from '../../../src/stacks/test/status';

const projects = new Map<string, { hasFailedState: boolean }>();

rs.mock('../../../src/stacks/test/project', () => ({
  Project: class {},
  WorkspaceManager: class {
    projects = projects;
    activeProjects = new Map();
    constructor() {}
    refresh() {}
    retryFailedProjects() {}
    setRstackConfigFiles() {}
    dispose() {}
  },
}));

rs.mock('../../../src/stacks/test/diagnostics', () => ({
  RstestDiagnostics: class {
    dispose() {}
  },
}));
rs.mock('../../../src/stacks/test/master', () => ({
  runningWorkers: new Set(),
  warmWorkerNodePreflight: () => {},
}));
rs.mock('../../../src/stacks/test/terminal', () => ({
  disposeTerminal: () => {},
}));
rs.mock('../../../src/stacks/test/testRunReporter', () => ({
  RstestFileCoverage: class {},
}));
rs.mock('../../../src/stacks/test/testTree', () => ({
  gatherTestItems: () => [],
  ProjectFolder: class {},
  TestCase: class {},
  TestFile: class {},
  TestFolder: class {},
  testData: new WeakMap(),
}));

const testController = {
  items: { replace: () => {} },
  createRunProfile: () => ({ dispose: () => {} }),
  dispose: () => {},
};

rs.mock('vscode', () => {
  const vscode = {
    tests: { createTestController: () => testController },
    commands: {
      registerCommand: () => ({ dispose: () => {} }),
      executeCommand: () => Promise.resolve(),
    },
    window: {},
    env: { clipboard: { writeText: () => Promise.resolve() } },
    TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
  };
  return { ...vscode, default: vscode };
});

const folder = {
  uri: {
    scheme: 'file',
    fsPath: '/repo',
    toString: () => 'file:///repo',
  },
  name: 'repo',
  index: 0,
} as any;

const context = {
  detection: {
    foldersFor: () => [{ folder }],
    forFolder: () => ({ stacks: { rstest: { rstackConfigFiles: [] } } }),
  },
  output: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
  status: {
    stack: 'rstest',
    report: () => {},
    starting: () => {},
    running: () => {},
    crashed: () => {},
    versionMismatch: () => {},
  },
  onDidChangeDetection: () => ({ dispose: () => {} }),
} as any;

describe('RstestController failed state', () => {
  beforeEach(() => {
    projects.clear();
  });

  it('folds raw project failures without losing singleton status crashes', async () => {
    const { createRstestController } =
      await import('../../../src/stacks/test/index');
    const controller = createRstestController();
    await controller.register(context);

    const project = { hasFailedState: false };
    projects.set('file:///repo/rstest.config.ts', project);
    expect(status.hasFailed()).toBe(false);
    expect(controller.hasFailedState()).toBe(false);

    project.hasFailedState = true;
    expect(status.hasFailed()).toBe(false);
    expect(controller.hasFailedState()).toBe(true);

    project.hasFailedState = false;
    expect(controller.hasFailedState()).toBe(false);

    status.crashed('worker stopped', 'singleton');
    expect(controller.hasFailedState()).toBe(true);

    controller.dispose();
  });
});
