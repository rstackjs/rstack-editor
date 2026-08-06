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
  stackCommand,
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

    register('rstack.showOutput', () => this.#channels.shell.show());
    register('rstack.restart', () => this.restart());
    register('rstack.migrateSettings', () =>
      runSettingsMigration(this.#channels.shell),
    );
    for (const stack of STACK_IDS) {
      register(stackCommand(stack, 'output.focus'), () =>
        this.#channels.forStack(stack).show(),
      );
      // Owned by the shell, not the stack: a stack cannot rebuild itself, and
      // the shallower alternative (bouncing just the tool's own process) leaves
      // the controller's package resolution and version check stale. Stacks
      // reach the same operation through `StackContext.requestRestart`.
      register(stackCommand(stack, 'restart'), () => this.restart(stack));
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

  /**
   * The single queue every pass runs on — reconciles and restarts alike. Two
   * passes must never overlap, and a caller awaiting the returned promise
   * waits for its own pass only. A rejection belongs to that caller, so the
   * chain keeps only the settled shape and survives it.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const pass = this.#reconciling.then(task);
    this.#reconciling = pass.catch(() => undefined);
    return pass;
  }

  private scheduleReconcile(): void {
    if (this.#disposed) {
      return;
    }
    void this.enqueue(() => this.reconcile());
  }

  /**
   * `rstack.restart` (every stack) and `rstack.<stack>.restart` (one) — a full
   * reset, not a "retry whatever looks broken".
   *
   * `reconcileStack` deliberately leaves an already registered stack alone, so
   * a stack that is up but wedged is never rebuilt: `node_modules` can be
   * replaced or corrupted while every watched file stays untouched, and until
   * now only a window reload recovered from that. This disposes the
   * controllers, re-runs detection and registers every affected stack that
   * still passes the gate, from scratch.
   *
   * `reason` is for the callers that are not a user picking the command —
   * `StackContext.requestRestart` passes what moved.
   */
  restart(stack?: StackId, reason?: string): Promise<void> {
    return this.enqueue(() => this.runRestart(stack, reason));
  }

  private async runRestart(only?: StackId, reason?: string): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const stacks = only ? [only] : STACK_IDS;
    const what = only ? STACK_LABELS[only] : 'Rstack';
    this.#channels.shell.info(
      `Restarting ${what}${reason ? ` (${reason})` : ''}`,
    );
    // Per-stack isolation covers the restart too: a stack throwing on the way
    // down must not keep the others from coming back up.
    await Promise.allSettled(
      [...this.#controllers]
        .filter(([stack]) => stacks.includes(stack))
        .map(([stack, controller]) =>
          this.retire(stack, controller, { kind: 'starting' }),
        ),
    );
    // Teardown is slow (closing the Rslint language client, `$close()`ing the
    // Rstest workers), so a `deactivate()` can land inside it. From here on
    // every shell resource — the output channels above all — may already be
    // disposed, and touching one throws.
    if (this.#disposed) {
      return;
    }
    try {
      // A plain pass: `refresh` updates the snapshot whether or not the
      // signature moved, and the reconcile below rebuilds every stack from it.
      // The forced notification the lockfile path uses exists to make *live*
      // controllers retry — there are none left to tell.
      await this.#detection.refresh();
    } catch (error) {
      if (!this.#disposed) {
        this.#channels.shell.error(
          `Detection failed during restart: ${errorMessage(error)}`,
        );
      }
    }
    await this.reconcile(stacks);
    if (!this.#disposed) {
      this.#channels.shell.info(`${what} restart finished`);
    }
  }

  /**
   * Retires a controller. Only the state left on the status bar says why
   * (`starting` for a restart about to rebuild it, the gate's own state when it
   * stopped qualifying, `crashed` when it failed to register). Pass no state to
   * retire it silently, which is what a shell already on its way out wants.
   */
  private async retire(
    stack: StackId,
    controller: StackController,
    next?: StackState,
  ): Promise<void> {
    this.#controllers.delete(stack);
    await this.disposeController(stack, controller);
    if (!next || this.#disposed) {
      return;
    }
    await this.setContextKey(`rstack.${stack}.active`, false);
    this.#statusBar.setActive(stack, false);
    this.#statusBar.setState(stack, next);
  }

  private async reconcile(
    stacks: readonly StackId[] = STACK_IDS,
  ): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const snapshot = this.#detection.snapshot;
    // Per-stack isolation: one stack throwing must never affect the others.
    await Promise.allSettled(
      stacks.map((stack) => this.reconcileStack(stack, snapshot)),
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
    // Setting a context key is a round trip to the main thread, and a restart
    // empties `#controllers` before getting here — so a `deactivate()` landing
    // in this window would find nothing to dispose and the controller built
    // below would outlive the extension.
    if (this.#disposed) {
      return;
    }

    const gate = this.gate(stack, snapshot);
    const existing = this.#controllers.get(stack);

    if (!gate.ok) {
      if (existing) {
        await this.retire(stack, existing, gate.state);
      } else {
        this.#statusBar.setState(stack, gate.state);
      }
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
        requestRestart: (reason) => this.restart(stack, reason),
      });
      // `register()` is the long await here (an LSP handshake, a worker spawn),
      // so `dispose()` can have run through its controller loop while this one
      // was still starting. Nothing else will collect it — do it here.
      if (this.#disposed) {
        await this.retire(stack, controller);
        return;
      }
      if (stackExports) {
        this.publishStackExports(stack, stackExports);
      }
      await this.setContextKey(`rstack.${stack}.active`, true);
      this.#statusBar.setActive(stack, true);
      this.#channels.shell.info(`${STACK_LABELS[stack]} registered`);
    } catch (error) {
      await this.retire(stack, controller, {
        kind: 'crashed',
        detail: error instanceof Error ? error.message : String(error),
      });
      if (this.#disposed) {
        return;
      }
      const message = errorMessage(error);
      this.#channels.shell.error(
        `${STACK_LABELS[stack]} failed to register: ${message}`,
      );
      this.#channels.forStack(stack).error(message);
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
      // `dispose()` closes the channels after its controller loop, and a stack
      // can still be shutting down then; a failed dispose must not become an
      // unhandled "channel closed" on the way out.
      if (this.#disposed) {
        return;
      }
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
    // Behind the shared queue rather than beside it. `retire` drops a
    // controller from `#controllers` before awaiting its teardown, so a
    // restart in flight leaves a window where the map is already empty and the
    // Rslint client is still shutting down: disposing the channels there would
    // pull them out from under it, and `deactivate()` would resolve before the
    // child processes are gone. The queue is what makes "whatever was in
    // flight has finished" something this can wait for, and `#disposed` above
    // stops that pass from rebuilding anything on its way out.
    //
    // The pass itself keeps the restart's shape: per-stack isolation, and
    // deactivate runs against VS Code's shutdown budget, so the slow ones
    // overlap instead of queueing.
    await this.enqueue(async () => {
      await Promise.allSettled(
        [...this.#controllers].map(([stack, controller]) =>
          this.retire(stack, controller),
        ),
      );
    });
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
