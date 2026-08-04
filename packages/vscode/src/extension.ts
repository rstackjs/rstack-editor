import vscode from 'vscode';
import { Channels } from './channels';
import { DetectionService } from './detection';
import { maybePromptForMigration, runSettingsMigration } from './migration';
import { StatusBar } from './statusBar';
import {
  type DetectionSnapshot,
  type RstackExtensionExports,
  type StackController,
  type StackControllerFactory,
  type StackId,
  type StackState,
  STACK_IDS,
  STACK_LABELS,
} from './types';
import { createFmtController } from './stacks/fmt';
import { createRslintController } from './stacks/lint';
import { createRstestController } from './stacks/test';

const STACK_FACTORIES: Readonly<Record<StackId, StackControllerFactory>> = {
  rslint: createRslintController,
  rstest: createRstestController,
  fmt: createFmtController,
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

type Gate =
  { readonly ok: true } | { readonly ok: false; readonly state: StackState };

/**
 * The extension shell: it always activates on
 * `onStartupFinished` and does exactly three things — create the status bar
 * item and the output channels, run detection, and register the stacks that
 * pass the gate `rstack.enable && rstack.<stack>.enable && detected(stack)`.
 *
 * A stack failing to register never takes another stack down.
 */
class ExtensionShell {
  readonly #channels = new Channels();
  readonly #statusBar = new StatusBar();
  readonly #detection: DetectionService;
  readonly #controllers = new Map<StackId, StackController>();
  readonly #subscriptions: vscode.Disposable[] = [];
  readonly #detectionEmitter = new vscode.EventEmitter<DetectionSnapshot>();
  // E2E-facing (RstackExtensionExports): live per-stack exports + waiters.
  readonly #stackExports = new Map<StackId, Record<string, unknown>>();
  readonly #stackExportWaiters = new Map<
    StackId,
    Array<(value: Record<string, unknown>) => void>
  >();

  #reconciling: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.#detection = new DetectionService(this.#channels.shell);
  }

  async activate(): Promise<void> {
    this.registerCommands();

    this.#subscriptions.push(
      this.#detection.onDidChange((snapshot) => {
        this.#detectionEmitter.fire(snapshot);
        this.scheduleReconcile();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        const affectsGate =
          event.affectsConfiguration('rstack.enable') ||
          STACK_IDS.some((stack) =>
            event.affectsConfiguration(`rstack.${stack}.enable`),
          );
        if (affectsGate) {
          this.scheduleReconcile();
        }
      }),
      // Restricted Mode shows the status bar only; trust unlocks the stacks
      // without a window reload.
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.#channels.shell.info(
          'Workspace trust granted, re-evaluating the stack gates',
        );
        this.scheduleReconcile();
      }),
    );

    this.#channels.shell.info(
      `Rstack shell activated (workspace trust: ${
        vscode.workspace.isTrusted ? 'granted' : 'restricted'
      })`,
    );

    await this.#detection.initialize();
    await this.reconcile();

    void maybePromptForMigration(this.context, this.#channels.shell);
  }

  private registerCommands(): void {
    const register = (command: string, handler: () => unknown) => {
      this.#subscriptions.push(
        vscode.commands.registerCommand(command, handler),
      );
    };

    register('rstack.showMenu', () => this.#statusBar.showMenu());
    register('rstack.showOutput', () => this.#channels.shell.show());
    register('rstack.migrateSettings', () =>
      runSettingsMigration(this.#channels.shell),
    );
    for (const stack of STACK_IDS) {
      register(`rstack.${stack}.output.focus`, () =>
        this.#channels.forStack(stack).show(),
      );
    }
  }

  /**
   * `rstack.enable && rstack.<stack>.enable && detected(stack)`.
   *
   * The two settings are declared `"scope": "window"` in the manifest, so
   * reading them without a resource URI is exactly what they promise: they are
   * kill switches for the window. Per-folder granularity is detection's job
   * and stays inside the controllers (`foldersFor(stack)`).
   */
  private gate(stack: StackId, snapshot: DetectionSnapshot): Gate {
    if (!snapshot.isDetected(stack)) {
      return { ok: false, state: { kind: 'not-detected' } };
    }
    if (!vscode.workspace.isTrusted) {
      return {
        ok: false,
        state: {
          kind: 'disabled',
          reason: 'the workspace is not trusted (Restricted Mode)',
        },
      };
    }
    if (
      !vscode.workspace.getConfiguration('rstack').get<boolean>('enable', true)
    ) {
      return {
        ok: false,
        state: { kind: 'disabled', reason: '`rstack.enable` is off' },
      };
    }
    if (
      !vscode.workspace
        .getConfiguration(`rstack.${stack}`)
        .get<boolean>('enable', true)
    ) {
      return {
        ok: false,
        state: {
          kind: 'disabled',
          reason: `\`rstack.${stack}.enable\` is off`,
        },
      };
    }
    return { ok: true };
  }

  private scheduleReconcile(): void {
    if (this.#disposed) {
      return;
    }
    this.#reconciling = this.#reconciling.then(
      () => this.reconcile(),
      () => this.reconcile(),
    );
  }

  private async reconcile(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const snapshot = this.#detection.snapshot;
    // Per-stack isolation: one stack throwing must never affect the others.
    await Promise.allSettled(
      STACK_IDS.map((stack) => this.reconcileStack(stack, snapshot)),
    );
  }

  private async reconcileStack(
    stack: StackId,
    snapshot: DetectionSnapshot,
  ): Promise<void> {
    await this.setContextKey(
      `rstack.${stack}.detected`,
      snapshot.isDetected(stack),
    );

    const gate = this.gate(stack, snapshot);
    const existing = this.#controllers.get(stack);

    if (!gate.ok) {
      if (existing) {
        this.#controllers.delete(stack);
        await this.disposeController(stack, existing);
        await this.setContextKey(`rstack.${stack}.active`, false);
        this.#statusBar.setActive(stack, false);
      }
      this.#statusBar.setState(stack, gate.state);
      return;
    }

    if (existing) {
      return;
    }

    const controller = STACK_FACTORIES[stack]();
    this.#controllers.set(stack, controller);
    this.#statusBar.setState(stack, { kind: 'starting' });

    try {
      const stackExports = await controller.register({
        stack,
        extensionContext: this.context,
        output: this.#channels.forStack(stack),
        status: this.#statusBar.reporterFor(stack),
        detection: snapshot,
        onDidChangeDetection: this.#detectionEmitter.event,
      });
      if (stackExports) {
        this.publishStackExports(stack, stackExports);
      }
      await this.setContextKey(`rstack.${stack}.active`, true);
      this.#statusBar.setActive(stack, true);
      this.#channels.shell.info(`${STACK_LABELS[stack]} registered`);
    } catch (error) {
      this.#controllers.delete(stack);
      await this.disposeController(stack, controller);
      await this.setContextKey(`rstack.${stack}.active`, false);
      this.#statusBar.setActive(stack, false);
      const message = errorMessage(error);
      this.#channels.shell.error(
        `${STACK_LABELS[stack]} failed to register: ${message}`,
      );
      this.#channels.forStack(stack).error(message);
      this.#statusBar.setState(stack, {
        kind: 'crashed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async disposeController(
    stack: StackId,
    controller: StackController,
  ): Promise<void> {
    this.#stackExports.delete(stack);
    try {
      await controller.dispose();
    } catch (error) {
      this.#channels.shell.error(
        `${STACK_LABELS[stack]} failed to dispose: ${errorMessage(error)}`,
      );
    }
  }

  private publishStackExports(
    stack: StackId,
    stackExports: Record<string, unknown>,
  ): void {
    this.#stackExports.set(stack, stackExports);
    const waiters = this.#stackExportWaiters.get(stack);
    if (waiters) {
      this.#stackExportWaiters.delete(stack);
      for (const resolve of waiters) {
        resolve(stackExports);
      }
    }
  }

  buildExports(): RstackExtensionExports {
    return {
      getStackExports: (stack) => this.#stackExports.get(stack),
      whenStackActive: (stack) => {
        const current = this.#stackExports.get(stack);
        if (current) {
          return Promise.resolve(current);
        }
        return new Promise((resolve) => {
          const waiters = this.#stackExportWaiters.get(stack) ?? [];
          waiters.push(resolve);
          this.#stackExportWaiters.set(stack, waiters);
        });
      },
    };
  }

  private async setContextKey(key: string, value: boolean): Promise<void> {
    try {
      await vscode.commands.executeCommand('setContext', key, value);
    } catch (error) {
      this.#channels.shell.warn(
        `Failed to set context key ${key}: ${errorMessage(error)}`,
      );
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const [stack, controller] of [...this.#controllers]) {
      this.#controllers.delete(stack);
      await this.disposeController(stack, controller);
    }
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#subscriptions.length = 0;
    this.#detectionEmitter.dispose();
    this.#detection.dispose();
    this.#statusBar.dispose();
    this.#channels.dispose();
  }
}

let shell: ExtensionShell | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<RstackExtensionExports> {
  const instance = new ExtensionShell(context);
  shell = instance;
  try {
    await instance.activate();
  } catch (activationError) {
    // Dispose whatever activation already created (channels, status bar,
    // listeners, partially registered stacks) — nothing here is registered in
    // `context.subscriptions`, so a leaked half-activation would survive.
    shell = undefined;
    try {
      await instance.dispose();
    } catch (disposeError) {
      throw new AggregateError(
        [activationError, disposeError],
        'Rstack activation failed, and cleaning up the partial activation failed too',
      );
    }
    throw activationError;
  }
  return instance.buildExports();
}

export async function deactivate(): Promise<void> {
  const current = shell;
  shell = undefined;
  await current?.dispose();
}
