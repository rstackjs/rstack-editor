import assert from 'node:assert';
import net from 'node:net';
import path from 'node:path';
import vscode from 'vscode';
import {
  FIXTURES_ROOT,
  getRstestExports,
  getTestItemByLabels,
  waitFor,
} from './helpers';

suite('Rstest debug launch', () => {
  for (const finish of ['continue', 'cancel', 'stop'] as const) {
    test(`hits a breakpoint with port 9229 occupied and cleans up after ${finish}`, async () => {
      const occupied = net.createServer();
      await new Promise<void>((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(9229, '127.0.0.1', resolve);
      });
      const cancellation = new vscode.CancellationTokenSource();
      const sessions = new Map<string, vscode.DebugSession>();
      const processIds = new Set<number>();
      const disposables: vscode.Disposable[] = [];
      const file = path.join(FIXTURES_ROOT, 'workspace-1/test/index.test.ts');
      const breakpoint = new vscode.SourceBreakpoint(
        new vscode.Location(vscode.Uri.file(file), new vscode.Position(5, 0)),
      );
      let stopped:
        { session: vscode.DebugSession; threadId: number } | undefined;
      const passed: vscode.TestItem[] = [];
      let ended = false;
      let running: Promise<void> | undefined;
      try {
        disposables.push(
          vscode.debug.onDidStartDebugSession((session) => {
            sessions.set(session.id, session);
          }),
          vscode.debug.onDidTerminateDebugSession((session) =>
            sessions.delete(session.id),
          ),
          vscode.debug.registerDebugAdapterTrackerFactory('*', {
            // js-debug resolves the public 'node' type to 'pwa-node'.
            createDebugAdapterTracker: (session) => ({
              onDidSendMessage: (message) => {
                if (
                  message.type === 'event' &&
                  message.event === 'stopped' &&
                  message.body.reason === 'breakpoint'
                ) {
                  stopped = { session, threadId: message.body.threadId };
                }
              },
            }),
          }),
        );
        vscode.debug.addBreakpoints([breakpoint]);
        const api = await getRstestExports();
        const item = await waitFor(() =>
          getTestItemByLabels(api.testController.items, [
            'test',
            'index.test.ts',
          ]),
        );
        const request = new vscode.TestRunRequest(
          [item],
          undefined,
          api.debugProfile,
        );
        // A real TestRun is required for startDebugging's testRun association.
        running = api.startTestRun(
          request,
          cancellation.token,
          false,
          (runRequest) => {
            const run = api.testController.createTestRun(runRequest);
            const originalPassed = run.passed.bind(run);
            const originalEnd = run.end.bind(run);
            run.passed = (test, duration) => {
              passed.push(test);
              originalPassed(test, duration);
            };
            run.end = () => {
              ended = true;
              originalEnd();
            };
            return run;
          },
        );
        await waitFor(
          () => assert.ok(stopped, 'debuggee should stop at the breakpoint'),
          { timeoutMs: 60_000 },
        );
        assert.ok(stopped);
        const stack = await stopped.session.customRequest('stackTrace', {
          threadId: stopped.threadId,
        });
        assert.equal(
          path.normalize(stack.stackFrames[0].source.path),
          path.normalize(file),
        );
        assert.equal(stack.stackFrames[0].line, 6);
        const root = [...sessions.values()].find(
          (session) => session.name === 'Rstest Debug',
        );
        assert.ok(root);
        for (const session of sessions.values()) {
          if (session.id === root.id) continue;
          const evaluation = await session.customRequest('evaluate', {
            expression: 'process.pid',
            context: 'repl',
          });
          const pid = Number(evaluation.result);
          assert.ok(Number.isInteger(pid) && pid > 0, evaluation.result);
          processIds.add(pid);
        }
        assert.ok(
          processIds.size >= 2,
          'worker and pool child must be debugged',
        );
        if (finish === 'continue') {
          await stopped.session.customRequest('continue', {
            threadId: stopped.threadId,
          });
        } else if (finish === 'cancel') {
          cancellation.cancel();
        } else {
          await vscode.debug.stopDebugging(root);
        }
        await waitFor(
          () => {
            assert.equal(ended, true, 'TestRun must end');
            if (finish === 'continue') {
              assert.deepEqual(passed.map((test) => test.label).sort(), [
                'Index',
                'index.test.ts',
                'should add two numbers correctly',
                'should test source code correctly',
              ]);
            }
            assert.equal(sessions.size, 0, 'all debug sessions must end');
            for (const pid of processIds) {
              assert.throws(
                () => process.kill(pid, 0),
                { code: 'ESRCH' },
                `process ${pid} must exit`,
              );
            }
          },
          { timeoutMs: 60_000 },
        );
        await running;
      } finally {
        cancellation.cancel();
        vscode.debug.removeBreakpoints([breakpoint]);
        await Promise.all(
          [...sessions.values()].map((session) =>
            vscode.debug.stopDebugging(session),
          ),
        );
        for (const disposable of disposables) disposable.dispose();
        cancellation.dispose();
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
      }
    });
  }
});
