import { Writable } from 'node:stream';
import type {
  Reporter,
  TestCaseInfo,
  TestFileInfo,
  TestFileResult,
  TestResult,
  TestSuiteInfo,
} from '@rstest/core';
import type {
  Context,
  ReportBase,
  ReportNode,
  Visitor,
} from 'istanbul-lib-report';
import type vscode from 'vscode';
import { masterApi } from '.';

export class ProgressReporter implements Reporter {
  readonly flushOutputStreams = false;

  // Suite results post through the same extension-host round-trip as case
  // results, but @rstest/core 0.12.6 only paces case-result deliveries (its
  // `createRunnerEventSink` chains each case's fanout behind the previous
  // delivery) and fires a suite delivery as soon as the runner hook returns.
  // A suite hook failure (an `afterAll` throw) therefore fires while a case
  // emitted before it may still be queued inside core, not yet handed to us;
  // on a slow extension host that suite failure can then post ahead of the
  // pending case failures of the same file, and the editor publishes
  // `run.failed` in arrival order — the exact macOS CI flip in
  // `e2e/rstest/suite/progress.test.ts`.
  //
  // Core's `onTestFileResult` waits for the case chain before fanning out,
  // so every case result has been delivered by file-result time; that join
  // point is what makes the deferral below deterministic. The queue lives in
  // this worker reporter, beside core's join: a master-side queue could
  // reproduce the order too, but would have to be threaded into every
  // worker-termination path (a failed run, a graceful close on cancellation,
  // `$close`) and would rest on birpc handler-invocation ordering instead of
  // sitting directly on core's own.
  //
  // Remaining coverage: `onTestRunEnd` flushes leftovers so a torn-down
  // attempt never loses queued results; a new attempt's
  // `onTestFileStart`/`onTestFileReady` (core re-runs a file only after a
  // worker SIGKILL retry) drops a previous attempt's queue. This mirrors
  // upstream 1.0's `runnerEventSink` (`joinHooks` before
  // `onTestFileResult`, #1875); our pinned 0.12.6 joins case deliveries
  // only. Offer this back upstream for the 0.12 line.
  private pendingSuiteResults = new Map<string, TestResult[]>();

  private async flushSuiteResults(testPath: string): Promise<void> {
    const queue = this.pendingSuiteResults.get(testPath);
    if (!queue) return;
    // Drop the queue first: a suite result arriving during the flush belongs
    // to a new emission sequence and starts a fresh queue instead of being
    // re-flushed by this loop.
    this.pendingSuiteResults.delete(testPath);
    for (const result of queue) {
      // A torn-down transport rejects here; keep flushing the rest of the
      // queue rather than abandoning it mid-way.
      await masterApi.onTestCaseResult(result).catch(() => {});
    }
  }

  onTestRunStart = () => {
    // Earlier runs flushed by now or were torn down mid-flight; a fresh run
    // must not inherit their queues (the master's TestRunReporter resets its
    // per-run caches the same way).
    this.pendingSuiteResults.clear();
    return masterApi.onTestRunStart();
  };
  onTestRunEnd = async () => {
    // Fallback for a file result that never came: flush in queue-arrival
    // order (a crashed attempt may hold suites) before the run closes, so
    // nothing queued is silently dropped. Live iteration: `flushSuiteResults`
    // deletes the entry before awaiting, so a queue re-added during a flush
    // is deleted by it as well, flushed by this same pass, and nothing is
    // left dangling for the next run's reset.
    for (const testPath of this.pendingSuiteResults.keys()) {
      await this.flushSuiteResults(testPath);
    }
    return masterApi.onTestRunEnd();
  };
  onTestFileStart = (test: TestFileInfo) => {
    // New attempt boundary: the previous attempt's queued suite results
    // belong to a discarded run and must not leak into this one.
    this.pendingSuiteResults.delete(test.testPath);
    return masterApi.onTestFileStart(test);
  };
  onTestFileReady = (test: TestFileInfo) => {
    this.pendingSuiteResults.delete(test.testPath);
    return masterApi.onTestFileReady(test);
  };
  onTestFileResult = async (test: TestFileResult) => {
    // Core drained its case chain by now (for this testPath), so every case
    // result precedes the flushed suites and the file result.
    await this.flushSuiteResults(test.testPath);
    return masterApi.onTestFileResult(test);
  };
  onTestSuiteStart = (test: TestSuiteInfo) => masterApi.onTestSuiteStart(test);
  onTestSuiteResult = (result: TestResult) => {
    // Queue instead of posting; delivery happens with the file result.
    // Returns immediately, so the returned promise no longer acknowledges
    // the extension host's handling of this result (upstream's ported unit
    // test is adapted accordingly in
    // `tests/stacks/test/workerReporter.test.ts`).
    let queue = this.pendingSuiteResults.get(result.testPath);
    if (!queue) {
      queue = [];
      this.pendingSuiteResults.set(result.testPath, queue);
    }
    queue.push(result);
  };
  onTestCaseStart = (test: TestCaseInfo) => masterApi.onTestCaseStart(test);
  // Case results stay awaitable master requests: core's delivery chain (and
  // the file-result join) settles per delivery, so the extension-host ack is
  // what paces the next case's posting path.
  onTestCaseResult = (result: TestResult) => masterApi.onTestCaseResult(result);
}

export class ProgressLogger {
  outputStream = new Writable({
    decodeStrings: false,
    write: (chunk, _encoding, cb) => {
      masterApi.onOutput.asEvent(chunk);
      cb(null);
    },
  });
  errorStream = this.outputStream;
  getColumns = () => Number.POSITIVE_INFINITY;
}

export class CoverageReporter
  // implements ReportBase instead of extend it, to prevent bundle istanbul-lib-report into output
  implements ReportBase, Partial<Visitor<ReportNode>>
{
  // https://github.com/istanbuljs/istanbuljs/blob/28ffdbc314596bdcb3007e85d30a62372602b262/packages/istanbul-lib-report/lib/report-base.js#L11-L13
  execute(context: Context) {
    context.getTree().visit(this, context);
  }

  onDetail(root: ReportNode) {
    const summary = root.getCoverageSummary(false);
    const coverage = root.getFileCoverage();

    const details: vscode.FileCoverageDetail[] = [];

    /** map istanbul range to vscode range */
    const mapRange = (
      range: (typeof coverage.statementMap)[string],
    ): vscode.Range =>
      ({
        // TODO why line maybe zero?
        start: {
          line: (range.start.line || 1) - 1,
          character: range.start.column,
        },
        end: { line: (range.end.line || 1) - 1, character: range.end.column },
      }) as vscode.Range;

    for (const [key, branchMapping] of Object.entries(coverage.branchMap)) {
      details.push({
        executed: coverage.b[key].some(Boolean),
        location: mapRange(branchMapping.loc),
        branches: branchMapping.locations.map((location, index) => ({
          executed: coverage.b[key][index],
          location: mapRange(location),
        })),
      } satisfies vscode.StatementCoverage);
    }

    for (const [key, functionMapping] of Object.entries(coverage.fnMap)) {
      details.push({
        name: functionMapping.name,
        executed: coverage.f[key] || 0,
        location: mapRange(functionMapping.loc),
      } satisfies vscode.DeclarationCoverage);
    }

    for (const [key, statementRange] of Object.entries(coverage.statementMap)) {
      details.push({
        branches: [],
        executed: coverage.s[key] || 0,
        location: mapRange(statementRange),
      } satisfies vscode.StatementCoverage);
    }

    masterApi.onCoverage.asEvent(
      coverage.path,
      summary.statements,
      summary.branches,
      summary.functions,
      details,
    );
  }

  onEnd() {
    masterApi.onCoverageEnd.asEvent();
  }
}
