import { describe, expect, it, rs } from '@rstest/core';
import type { TestFileResult, TestResult } from '@rstest/core';
import type vscode from 'vscode';
import type { TestResultStatus } from '../../../src/stacks/test/compat/rstestPre013';
import type { Project } from '../../../src/stacks/test/project';
import { TestRunReporter } from '../../../src/stacks/test/testRunReporter';

rs.mock('vscode', () => {
  const vscode = {
    Uri: {
      file: (fsPath: string) => ({
        fsPath,
        toString: () => `file://${fsPath}`,
      }),
    },
    FileCoverage: class {},
    Location: class {},
    Position: class {},
    Range: class {},
    TestMessage: class {},
  };
  return { ...vscode, default: vscode };
});

const TEST_PATH = '/workspace/adds.test.ts';
const TEST_URI = `file://${TEST_PATH}`;

const createRun = () => ({
  passed: rs.fn(),
  failed: rs.fn(),
  skipped: rs.fn(),
});
type RunSpies = ReturnType<typeof createRun>;
type Outcome = Exclude<TestResultStatus, 'todo'>;

// Every row a reporting handler must route: the 0.13 vocabulary plus the
// pre-0.13 aliases that normalize onto it.
const STATUS_CASES = [
  ['passed', 'passed'],
  ['failed', 'failed'],
  ['skipped', 'skipped'],
  ['todo', 'skipped'],
  // COMPAT(rstest<0.13): legacy vocabulary rows, deleted with the shim.
  ['pass', 'passed'],
  ['fail', 'failed'],
  ['skip', 'skipped'],
] as const;

// COMPAT(rstest<0.13): the installed devDependency still types reporter
// statuses as pass/fail/skip, while these fixtures use the 0.13 vocabulary.
// One cast here instead of `as any` at every fixture; deleted with the shim.
const payload = <T>(value: object): T => value as T;

const fileResult = (status: string): TestFileResult =>
  payload<TestFileResult>({
    testId: `file:${TEST_PATH}`,
    testPath: TEST_PATH,
    name: 'adds.test.ts',
    project: 'default',
    status,
    duration: 5,
    results: [],
  });

const caseResult = (status: string): TestResult =>
  payload<TestResult>({
    testId: 'case:adds',
    testPath: TEST_PATH,
    name: 'adds',
    parentNames: [],
    project: 'default',
    status,
    duration: 2,
  });

const setup = () => {
  const caseItem = { label: 'adds', children: new Map() };
  const fileItem = {
    label: 'adds.test.ts',
    children: new Map([['adds', caseItem]]),
  };
  const project = payload<Project>({
    testFiles: new Map([[TEST_URI, { testItem: fileItem }]]),
  });
  const run = createRun();
  const reporter = new TestRunReporter(
    payload<vscode.TestRun>(run),
    project,
    [],
    false,
  );
  return { reporter, run, fileItem, caseItem };
};

const expectOnly = (run: RunSpies, outcome: Outcome) => {
  expect(run[outcome]).toHaveBeenCalledTimes(1);
  for (const other of ['passed', 'failed', 'skipped'] as const) {
    if (other !== outcome) expect(run[other]).not.toHaveBeenCalled();
  }
};

describe('TestRunReporter file results', () => {
  it.each(STATUS_CASES)(
    'reports a %s file result as %s',
    async (status, outcome) => {
      const { reporter, run, fileItem } = setup();

      await reporter.onTestFileResult(fileResult(status));

      expectOnly(run, outcome);
      if (outcome === 'failed') {
        expect(run.failed).toHaveBeenCalledWith(fileItem, [], 5);
      } else if (outcome === 'passed') {
        expect(run.passed).toHaveBeenCalledWith(fileItem, 5);
      } else {
        expect(run.skipped).toHaveBeenCalledWith(fileItem);
      }
    },
  );
});

describe('TestRunReporter case results', () => {
  it.each(STATUS_CASES)(
    'reports a %s case result as %s',
    async (status, outcome) => {
      const { reporter, run, caseItem } = setup();

      await reporter.onTestCaseResult(caseResult(status));

      expectOnly(run, outcome);
      if (outcome === 'skipped') {
        expect(run.skipped).toHaveBeenCalledWith(caseItem);
      } else if (outcome === 'failed') {
        expect(run.failed).toHaveBeenCalledWith(caseItem, [], 2);
      } else {
        expect(run.passed).toHaveBeenCalledWith(caseItem, 2);
      }
    },
  );
});

describe('TestRunReporter unknown status', () => {
  it('does not report an outcome for a status from neither vocabulary', async () => {
    const { reporter, run } = setup();

    await reporter.onTestCaseResult(caseResult('pending'));

    expect(run.passed).not.toHaveBeenCalled();
    expect(run.failed).not.toHaveBeenCalled();
    expect(run.skipped).not.toHaveBeenCalled();
  });
});
