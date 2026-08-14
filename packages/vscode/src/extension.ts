import vscode from 'vscode';
import { Channels } from './channels';
import { DetectionService } from './detection';
import { maybePromptForMigration, runSettingsMigration } from './migration';
import { resetUserNodeCaches } from './shared/nodeResolution';
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

/**
 * The stacks that run project code on a User Node runtime and therefore read
 * the host-scoped preflight memo (`shared/nodeResolution.ts`) — the set
 * `runRestart` checks before resetting it. Lint is deliberately absent: it
 * still runs on the VS Code Node runtime (ADR 0001's recorded debt).
 */
const USER_NODE_STACKS: readonly StackId[] = ['rstest', 'fmt'];

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
  readonly #statusBar = new StatusBar(this.#channels.shell);
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
        // One event covers a whole batch of edits — saving settings.json moves
        // everything at once — and the answer to any relevant one is a single
        // full restart pass: it re-evaluates every gate and rebuilds every
        // controller, so a gate flip, a moved shared setting, or both in one
        // save are all handled by construction. Per-stack selectivity (gate
        // changes to the reconcile, declared settings to a targeted restart)
        // was removed deliberately: settings edits are rare, and the split
        // could swallow a restart when one save wrote a gate key at its
        // already-effective value alongside a shared setting.
        const reasons = new Set<string>();
        const note = (key: string): void => {
          if (event.affectsConfiguration(key)) {
            reasons.add(key);
          }
        };
        note('rstack.enable');
        for (const stack of STACK_IDS) {
          note(`rstack.${stack}.enable`);
        }
        // Declared settings are known per live controller. A stack behind a
        // closed gate has none — and needs none: its own settings cannot
        // matter until an enable flip (caught above) lets it register, which
        // reads everything fresh.
        for (const [stack, controller] of this.#controllers) {
          for (const setting of controller.restartOnSettings ?? []) {
            // Entries are relative to the stack's namespace unless they name a
            // fully qualified `rstack.*` key — the form shared settings use.
            note(
              setting.startsWith('rstack.')
                ? setting
                : `rstack.${stack}.${setting}`,
            );
          }
        }
        if (reasons.size > 0) {
          void this.restart(undefined, `${[...reasons].join(', ')} changed`);
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
    // On the queue, not beside it. `registerCommands` runs before this method's
    // first await, so a restart can be invoked from the palette while detection
    // is still initialising — and running beside it would let that restart
    // retire a controller whose `register()` has not returned yet.
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
      // reach the same operation by declaring `restartOnSettings`.
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

  /**
   * Queues a reconcile. The `run*` methods below are the bodies of a pass and
   * assume they already own the queue — going through `enqueue` from inside
   * one would wait on itself. Everything else calls the wrappers.
   */
  private reconcile(): Promise<void> {
    return this.enqueue(() => this.runReconcile());
  }

  private scheduleReconcile(): void {
    if (this.#disposed) {
      return;
    }
    void this.reconcile();
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
   * `restartOnSettings` passes what moved.
   */
  restart(stack?: StackId, reason?: string): Promise<void> {
    return this.enqueue(() => this.runRestart(stack, reason));
  }

  private async runRestart(only?: StackId, reason?: string): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const stacks = only === undefined ? STACK_IDS : [only];
    const what = only === undefined ? 'Rstack' : STACK_LABELS[only];
    this.#channels.shell.info(
      `Restarting ${what}${reason ? ` (${reason})` : ''}`,
    );
    await this.retireAll(stacks, { kind: 'starting' });
    // Teardown is slow (closing the Rslint language client, `$close()`ing the
    // Rstest workers), so a `deactivate()` can land inside it. From here on
    // every shell resource — the output channels above all — may already be
    // disposed, and touching one throws.
    if (this.#disposed) {
      return;
    }
    // Restart exists to clear stale resolution, and the User Node preflight
    // memo is host-scoped state shared by every stack that runs project code
    // on a User Node runtime — so the shell clears it once per pass, after the
    // retire wave and before anything re-registers. Owned here rather than in
    // the stacks' `dispose()`: a stack-owned reset fires on every teardown
    // (deactivate, detection loss) and clears the resolution a live sibling
    // stack is relying on, twice per shared-setting change.
    //
    // Cleared only when no consumer of the memo survives the retire wave: a
    // single-stack `rstack.fmt.restart` must not yank the decision a live
    // Rstest controller's next worker spawn would silently re-take — its
    // controller was never rebuilt, so it could end up on a different runtime
    // than the workers it already has. The full `rstack.restart` (the "like a
    // window reload" gesture) always qualifies, as does the full pass any
    // relevant settings change triggers. `#controllers` holds only the
    // survivors at this point — `retireAll` above removed everything being
    // restarted.
    const memoConsumerSurvives = USER_NODE_STACKS.some((stack) =>
      this.#controllers.has(stack),
    );
    if (!memoConsumerSurvives) {
      resetUserNodeCaches();
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
    await this.runReconcile(stacks);
    if (!this.#disposed) {
      this.#channels.shell.info(`${what} restart finished`);
    }
  }

  /**
   * Retires whichever of `stacks` are registered. Per-stack isolation covers
   * teardown too: one throwing on the way down must not keep the others from
   * coming back up, or from being collected at all.
   */
  private async retireAll(
    stacks: readonly StackId[],
    next?: StackState,
  ): Promise<void> {
    await Promise.allSettled(
      [...this.#controllers]
        .filter(([stack]) => stacks.includes(stack))
        .map(([stack, controller]) => this.retire(stack, controller, next)),
    );
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

  private async runReconcile(
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
    // `#disposed` flips outside the queue, so it can become true mid-pass even
    // though the teardown that follows it cannot start until this pass ends.
    // Bailing here is the optimisation, not the safety net: anything this pass
    // did register lands in `#controllers` and the queued teardown collects it.
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
      });
      // Retiring it here rather than leaving it to the queued teardown skips
      // publishing exports and flipping `active` on for a stack the extension
      // is already shutting down.
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
    // Before the wait below, not after it: the service holds a debounce timer
    // and its own watchers, so leaving it live means a file touched during
    // shutdown can start a fresh detection pass behind us.
    this.#detection.dispose();
    // Behind the shared queue rather than beside it. `retire` drops a
    // controller from `#controllers` before awaiting its teardown, so a
    // restart in flight leaves a window where the map is already empty and the
    // Rslint client is still shutting down: disposing the channels there would
    // pull them out from under it, and `deactivate()` would resolve before the
    // child processes are gone. The queue is what makes "whatever was in
    // flight has finished" something this can wait for, and `#disposed` above
    // stops that pass from rebuilding anything on its way out.
    await this.enqueue(() => this.retireAll(STACK_IDS));
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#subscriptions.length = 0;
    this.#detectionEmitter.dispose();
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
