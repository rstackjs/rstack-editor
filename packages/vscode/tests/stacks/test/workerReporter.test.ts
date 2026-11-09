import { beforeEach, expect, it, rs } from '@rstest/core';
import { ProgressReporter } from '../../../src/stacks/test/worker/reporter';

type MasterCall = { method: string; name: string };
const masterCalls: MasterCall[] = [];
let pendingAcks: { resolve(): void }[] = [];

beforeEach(() => {
  pendingAcks = [];
  masterCalls.length = 0;
});

// Result callbacks (`onTestCaseResult`, `onTestFileResult`, which the worker
// flushes queued suite results through, and `onTestRunEnd`) stay master
// requests: each call registers an ack the test settles on demand.
// Everything else is fire-and-forget, so its mock resolves immediately.
rs.mock('../../../src/stacks/test/worker', () => {
  const immediate = Object.assign(async () => {}, { asEvent: async () => {} });
  const eventFor = (method: string) =>
    Object.assign(
      (...args: unknown[]) => {
        const payload = (args[0] ?? {}) as { name?: string };
        masterCalls.push({ method, name: payload.name ?? '' });
        const ack = Promise.withResolvers<void>();
        pendingAcks.push(ack);
        return ack.promise;
      },
      { asEvent: async () => {} },
    );
  return {
    masterApi: {
      onTestRunStart: immediate,
      onTestRunEnd: eventFor('onTestRunEnd'),
      onTestFileStart: immediate,
      onTestFileReady: immediate,
      onTestFileResult: eventFor('onTestFileResult'),
      onTestSuiteStart: immediate,
      onTestSuiteResult: immediate,
      onTestCaseStart: immediate,
      onTestCaseResult: eventFor('onTestCaseResult'),
    },
  };
});

// Resolves the most recently registered acknowledgement. `pendingAcks` keeps
// only unresolved acks; a call's ack is added synchronously with the call,
// so later helper hangs surface as a test timeout, not a length confusion.
const settleLastAck = (): void => {
  const ack = pendingAcks.pop();
  if (!ack) throw new Error('no pending acknowledgement');
  ack.resolve();
};

// Lets the reporter's queue/flush machinery issue its pending master calls;
// a chain hop must land before the next call is visible or settle-able.
const flushTicks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const call = (method: string, name: string): MasterCall => ({ method, name });
const FILE = '/fixtures/workspace-1/test/progress.test.ts';

// Ported from upstream `rstest/packages/vscode/tests/unit/workerReporter.test.ts`.
//
// Adaptation: upstream also asserted `onTestSuiteResult` waits for the
// extension host's acknowledgement. Our reporter defers suite deliveries to
// the file result to keep suite hook errors ordered after the pending case
// results of the same file (`worker/reporter.ts`), so a suite result no
// longer contacts the master on arrival; its acknowledgement is the file
// result's flush instead. The case/file assertions below stay upstream's.
it('waits for result callbacks to finish in the extension host', async () => {
  const reporter = new ProgressReporter();
  for (const report of [
    () => reporter.onTestCaseResult({} as any),
    () => reporter.onTestFileResult({} as any),
  ]) {
    const before = masterCalls.length;
    let settled = false;
    const reporting = report().then(() => {
      settled = true;
    });
    await flushTicks();
    expect(settled).toBe(false);
    expect(masterCalls.length).toBe(before + 1);
    settleLastAck();
    await reporting;
    expect(settled).toBe(true);
  }
});

// Models the pinned @rstest/core's worker-side pacing (`createRunnerEventSink`
// in 0.12.6): core hands our reporter one case result only after the previous
// delivery's extension-host acknowledgement, while a suite result fires as
// soon as the runner hook returns — which can happen while a case emitted
// before it is still queued inside core, not yet handed to us. The suite
// failure must not overtake the pending case results at the master: suite
// deliveries defer to the file result, which core fans out after its case
// chain drained. (Fails against the previous fix's `caseResultChain`, which
// only saw deliveries already handed to us.)
it('delivers queued suite results after every pending case of the file', async () => {
  const reporter = new ProgressReporter();
  const caseOne = { testPath: FILE, name: 'should mismatch number' } as any;
  const caseTwo = {
    testPath: FILE,
    name: 'should mismatch inline snapshot',
  } as any;
  const suiteResult = { testPath: FILE, name: 's1' } as any;

  // Case one reaches us; the extension host is slow to answer.
  const caseOneDelivered = reporter.onTestCaseResult(caseOne);
  // The suite result fires while case one is still pending — core cannot
  // have handed us case two yet (it arrives only after case one's ack).
  reporter.onTestSuiteResult(suiteResult);

  // Against an arrival-order delivery this is where the suite result would
  // already have been posted.
  expect(masterCalls).toEqual([
    call('onTestCaseResult', 'should mismatch number'),
  ]);
  expect(pendingAcks).toHaveLength(1);

  settleLastAck();
  await caseOneDelivered;
  const caseTwoDelivered = reporter.onTestCaseResult(caseTwo);
  expect(masterCalls).toEqual([
    call('onTestCaseResult', 'should mismatch number'),
    call('onTestCaseResult', 'should mismatch inline snapshot'),
  ]);

  settleLastAck();
  await caseTwoDelivered;
  // The file result fans out after core's case chain drained; it flushes the
  // queued suite result first, then posts the file result itself.
  const fileResultDelivered = reporter.onTestFileResult({
    testPath: FILE,
    name: '',
    results: [],
  } as any);
  await flushTicks();
  expect(masterCalls).toEqual([
    call('onTestCaseResult', 'should mismatch number'),
    call('onTestCaseResult', 'should mismatch inline snapshot'),
    call('onTestCaseResult', 's1'),
  ]);

  settleLastAck();
  await flushTicks();
  expect(masterCalls).toEqual([
    call('onTestCaseResult', 'should mismatch number'),
    call('onTestCaseResult', 'should mismatch inline snapshot'),
    call('onTestCaseResult', 's1'),
    call('onTestFileResult', ''),
  ]);

  settleLastAck();
  await fileResultDelivered;
  expect(pendingAcks).toHaveLength(0);
});

// A file result that never comes (worker torn down mid-run) must still
// surface its queued suite failures before the run closes.
it('flushes a leftover queue at run end', async () => {
  const reporter = new ProgressReporter();

  reporter.onTestSuiteResult({ testPath: FILE, name: 's1' } as any);
  expect(masterCalls).toEqual([]);

  const runEnd = reporter.onTestRunEnd();
  await flushTicks();
  expect(masterCalls).toEqual([call('onTestCaseResult', 's1')]);

  settleLastAck();
  await flushTicks();
  expect(masterCalls).toEqual([
    call('onTestCaseResult', 's1'),
    call('onTestRunEnd', ''),
  ]);

  settleLastAck();
  await runEnd;
  expect(pendingAcks).toHaveLength(0);
});

// A new attempt (core only re-runs a file after a worker SIGKILL retry)
// drops the previous attempt's queued suite results instead of leaking them
// into the re-run.
it('drops a queue taken over by a new attempt', async () => {
  const reporter = new ProgressReporter();

  reporter.onTestSuiteResult({ testPath: FILE, name: 's1' } as any);
  reporter.onTestFileStart({ testPath: FILE } as any);

  const fileResultDelivered = reporter.onTestFileResult({
    testPath: FILE,
    name: '',
    results: [],
  } as any);
  await flushTicks();
  // No flush call happened: the queue was dropped with the old attempt.
  expect(masterCalls).toEqual([call('onTestFileResult', '')]);
  expect(pendingAcks).toHaveLength(1);

  settleLastAck();
  await fileResultDelivered;
  expect(pendingAcks).toHaveLength(0);
});
