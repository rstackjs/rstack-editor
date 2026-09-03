// Ported from web-infra-dev/rslint
// `packages/vscode-extension/__tests__/suite-jsconfig/trace-output-channel.test.ts`
// (origin/main). Intentional adaptations:
// - The LanguageClient id and setting section use this extension's
//   `rstack.rslint` namespace.
// - Every client uses one in-memory `Rstack: Rslint` channel for ordinary logs
//   and protocol traces, matching this extension's four-channel cap. The
//   upstream assertion that traces avoid separate per-server log channels is
//   therefore replaced by assertions against the one shared channel.
// - The raw test server uses this repo's existing direct `vscode-jsonrpc`
//   dependency rather than adding upstream's `vscode-languageserver` test
//   dependency. It observes the same initialize trace field and `$/setTrace`
//   notifications.
import * as assert from 'node:assert';
import { PassThrough } from 'node:stream';
import {
  ConfigurationTarget,
  Uri,
  workspace,
  type OutputChannel,
  type ViewColumn,
  type WorkspaceFolder,
} from 'vscode';
import {
  LanguageClient,
  State,
  type StreamInfo,
} from 'vscode-languageclient/node';
import {
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { createLanguageClientOptions } from '../../../src/stacks/lint/Rslint';

type TraceValue = 'off' | 'messages' | 'verbose';

class MemoryOutputChannel implements OutputChannel {
  public readonly name = 'Rstack: Rslint';
  public value = '';
  public disposeCalls = 0;

  public append(value: string): void {
    this.value += value;
  }

  public appendLine(value: string): void {
    this.value += `${value}\n`;
  }

  public replace(value: string): void {
    this.value = value;
  }

  public clear(): void {
    this.value = '';
  }

  public show(preserveFocus?: boolean): void;
  public show(column?: ViewColumn, preserveFocus?: boolean): void;
  public show(
    _columnOrPreserveFocus?: ViewColumn | boolean,
    _preserveFocus?: boolean,
  ): void {}

  public hide(): void {}

  public dispose(): void {
    this.disposeCalls++;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTraceValue(value: unknown): value is TraceValue {
  return value === 'off' || value === 'messages' || value === 'verbose';
}

async function eventually(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

interface TraceClientHarness {
  readonly client: LanguageClient;
  readonly initialTrace: TraceValue | undefined;
  readonly serverStarts: number;
  readonly traceUpdates: TraceValue[];
  dispose(): Promise<void>;
}

function createTraceClientHarness(
  name: string,
  workspaceFolder: WorkspaceFolder,
  sharedOutputChannel: OutputChannel,
): TraceClientHarness {
  let serverStarts = 0;
  let initialTrace: TraceValue | undefined;
  const traceUpdates: TraceValue[] = [];
  let connection: MessageConnection | undefined;
  let clientInput: PassThrough | undefined;
  let clientOutput: PassThrough | undefined;
  const client = new LanguageClient(
    'rstack.rslint',
    name,
    async (): Promise<StreamInfo> => {
      serverStarts++;
      clientInput = new PassThrough();
      clientOutput = new PassThrough();
      connection = createMessageConnection(clientOutput, clientInput);
      connection.onRequest((method, params) => {
        if (method === 'initialize') {
          initialTrace =
            isRecord(params) && isTraceValue(params.trace)
              ? params.trace
              : undefined;
          return { capabilities: {} };
        }
        if (method === 'shutdown') return undefined;
        throw new Error(`Unexpected request: ${method}`);
      });
      connection.onNotification((method, params) => {
        if (method !== '$/setTrace') return;
        if (isRecord(params) && isTraceValue(params.value)) {
          traceUpdates.push(params.value);
        }
      });
      connection.listen();
      return { reader: clientInput, writer: clientOutput };
    },
    createLanguageClientOptions(
      workspaceFolder,
      sharedOutputChannel,
      sharedOutputChannel,
    ),
  );

  return {
    client,
    traceUpdates,
    get initialTrace() {
      return initialTrace;
    },
    get serverStarts() {
      return serverStarts;
    },
    async dispose(): Promise<void> {
      try {
        await client.dispose();
      } finally {
        connection?.dispose();
        clientInput?.destroy();
        clientOutput?.destroy();
      }
    },
  };
}

suite('Rstack Rslint LSP trace', () => {
  test('updates every runtime without replacing clients', async function () {
    this.timeout(15_000);
    const workspaceFolder = workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'test requires a workspace folder');
    const secondWorkspaceFolder: WorkspaceFolder = {
      index: workspaceFolder.index + 1,
      name: workspaceFolder.name,
      uri: Uri.joinPath(workspaceFolder.uri, 'second-runtime'),
    };
    const configuration = workspace.getConfiguration('rstack.rslint');
    const originalWorkspaceValue =
      configuration.inspect<string>('trace.server')?.workspaceValue;
    const sharedOutputChannel = new MemoryOutputChannel();
    const harnesses = [
      createTraceClientHarness(
        'Rslint live trace test A',
        workspaceFolder,
        sharedOutputChannel,
      ),
      createTraceClientHarness(
        'Rslint live trace test B',
        secondWorkspaceFolder,
        sharedOutputChannel,
      ),
      // A second client for the same workspace models documents that resolve
      // to another physical core installation within that workspace.
      createTraceClientHarness(
        'Rslint live trace test C',
        workspaceFolder,
        sharedOutputChannel,
      ),
    ];

    try {
      await configuration.update(
        'trace.server',
        'off',
        ConfigurationTarget.Workspace,
      );
      await harnesses[0].client.start();
      assert.strictEqual(harnesses[0].initialTrace, 'off');
      assert.strictEqual(harnesses[0].serverStarts, 1);
      assert.strictEqual(harnesses[1].serverStarts, 0);
      assert.strictEqual(harnesses[2].serverStarts, 0);

      const outputLengthBeforeOffProbe = sharedOutputChannel.value.length;
      await harnesses[0].client.sendNotification('rslint/traceProbe', {
        phase: 'off',
      });
      assert.strictEqual(
        sharedOutputChannel.value.length,
        outputLengthBeforeOffProbe,
      );

      await configuration.update(
        'trace.server',
        'messages',
        ConfigurationTarget.Workspace,
      );
      await eventually(
        () => harnesses[0].traceUpdates.includes('messages'),
        'the messages trace notification for the running runtime',
      );
      // A runtime created after the setting changed must inherit the current
      // level in initialize rather than waiting for another settings event.
      await Promise.all([
        harnesses[1].client.start(),
        harnesses[2].client.start(),
      ]);
      for (const harness of harnesses.slice(1)) {
        assert.strictEqual(harness.initialTrace, 'messages');
        assert.strictEqual(harness.serverStarts, 1);
      }
      await Promise.all(
        harnesses.map(({ client }, index) =>
          client.sendNotification('rslint/traceProbe', {
            phase: `messages-${String(index)}`,
          }),
        ),
      );
      assert.ok(
        sharedOutputChannel.value.split('rslint/traceProbe').length - 1 >=
          harnesses.length,
        'every runtime should write protocol messages to the shared channel',
      );

      await configuration.update(
        'trace.server',
        'verbose',
        ConfigurationTarget.Workspace,
      );
      await eventually(
        () =>
          harnesses.every(({ traceUpdates }) =>
            traceUpdates.includes('verbose'),
          ),
        'the verbose trace notification for every runtime',
      );
      await Promise.all(
        harnesses.map(({ client }, index) =>
          client.sendNotification('rslint/traceProbe', {
            phase: `verbose-payload-${String(index)}`,
          }),
        ),
      );
      for (const index of harnesses.keys()) {
        assert.ok(
          sharedOutputChannel.value.includes(
            `verbose-payload-${String(index)}`,
          ),
        );
      }

      await configuration.update(
        'trace.server',
        'off',
        ConfigurationTarget.Workspace,
      );
      await eventually(
        () =>
          harnesses.every(({ traceUpdates }) => traceUpdates.at(-1) === 'off'),
        'the disabled trace notification for every runtime',
      );
      const traceLengthAfterDisable = sharedOutputChannel.value.length;
      await Promise.all(
        harnesses.map(({ client }) =>
          client.sendNotification('rslint/traceProbe', {
            phase: 'disabled-again',
          }),
        ),
      );
      assert.strictEqual(
        sharedOutputChannel.value.length,
        traceLengthAfterDisable,
      );
      for (const harness of harnesses) {
        assert.strictEqual(harness.client.state, State.Running);
        assert.strictEqual(harness.serverStarts, 1);
      }
    } finally {
      let outputDisposeCallsAfterClientClose: number | undefined;
      try {
        await Promise.all(harnesses.map((harness) => harness.dispose()));
      } finally {
        outputDisposeCallsAfterClientClose = sharedOutputChannel.disposeCalls;
        sharedOutputChannel.dispose();
        await configuration.update(
          'trace.server',
          originalWorkspaceValue,
          ConfigurationTarget.Workspace,
        );
      }
      assert.strictEqual(
        outputDisposeCallsAfterClientClose,
        0,
        'language clients must not dispose the extension-owned channel',
      );
    }
  });
});
