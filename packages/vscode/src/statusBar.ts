import vscode from 'vscode';
import {
  type StackId,
  type StackState,
  type StatusReporter,
  STACK_IDS,
  STACK_LABELS,
} from './types';

/** Commands the status bar hover links to, per stack. */
const OUTPUT_COMMANDS: Readonly<Record<StackId, string>> = {
  rslint: 'rstack.rslint.output.focus',
  rstest: 'rstack.rstest.output.focus',
  fmt: 'rstack.fmt.output.focus',
};

const RESTART_COMMANDS: Partial<Readonly<Record<StackId, string>>> = {
  rslint: 'rstack.rslint.restart',
};

const STATE_ICONS: Readonly<Record<StackState['kind'], string>> = {
  'not-detected': '$(circle-slash)',
  disabled: '$(circle-slash)',
  starting: '$(loading~spin)',
  running: '$(check)',
  crashed: '$(error)',
  'version-mismatch': '$(warning)',
};

const stateText = (state: StackState): string => {
  switch (state.kind) {
    case 'not-detected':
      return 'not detected';
    case 'disabled':
      return state.reason ? `disabled — ${state.reason}` : 'disabled';
    case 'starting':
      return state.detail ? `starting — ${state.detail}` : 'starting';
    case 'running':
      return state.detail ? `running — ${state.detail}` : 'running';
    case 'crashed':
      return `crashed — ${state.detail}`;
    case 'version-mismatch':
      return `version mismatch — ${state.detail}`;
  }
};

/**
 * The single always-present status bar item. It is visible
 * whenever the extension is installed and enabled, even when nothing is
 * detected — it is the answer to "is the extension broken or just idle?".
 */
export class StatusBar implements vscode.Disposable {
  readonly #item: vscode.StatusBarItem;
  readonly #states = new Map<StackId, StackState>(
    STACK_IDS.map((stack) => [stack, { kind: 'not-detected' }]),
  );

  constructor() {
    this.#item = vscode.window.createStatusBarItem(
      'rstack.status',
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.#item.name = 'Rstack';
    this.#item.command = 'rstack.showMenu';
    this.render();
    this.#item.show();
  }

  reporterFor(stack: StackId): StatusReporter {
    return {
      stack,
      report: (state) => this.setState(stack, state),
      starting: (detail) => this.setState(stack, { kind: 'starting', detail }),
      running: (detail) => this.setState(stack, { kind: 'running', detail }),
      crashed: (detail) => this.setState(stack, { kind: 'crashed', detail }),
      versionMismatch: (detail) =>
        this.setState(stack, { kind: 'version-mismatch', detail }),
    };
  }

  setState(stack: StackId, state: StackState): void {
    this.#states.set(stack, state);
    this.render();
  }

  stateOf(stack: StackId): StackState {
    return this.#states.get(stack) ?? { kind: 'not-detected' };
  }

  /** The QuickPick behind the status bar item. */
  async showMenu(): Promise<void> {
    type Item = vscode.QuickPickItem & { readonly command?: string };
    const items: Item[] = [];
    for (const stack of STACK_IDS) {
      const state = this.stateOf(stack);
      items.push({
        label: `${STATE_ICONS[state.kind]} ${STACK_LABELS[stack]}`,
        description: stateText(state),
        detail: 'Show output',
        command: OUTPUT_COMMANDS[stack],
      });
      const restart = RESTART_COMMANDS[stack];
      if (restart && state.kind !== 'not-detected') {
        items.push({
          label: `$(refresh) Restart ${STACK_LABELS[stack]}`,
          command: restart,
        });
      }
    }
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      {
        label: '$(output) Show Rstack extension log',
        command: 'rstack.showOutput',
      },
      {
        label: '$(arrow-right) Migrate Rslint/Rstest settings',
        command: 'rstack.migrateSettings',
      },
    );

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Rstack',
      placeHolder: 'Select an action',
    });
    if (picked?.command) {
      await vscode.commands.executeCommand(picked.command);
    }
  }

  private render(): void {
    const states = STACK_IDS.map((stack) => this.stateOf(stack));
    const worst = states.find((state) => state.kind === 'crashed')
      ? 'crashed'
      : states.find((state) => state.kind === 'version-mismatch')
        ? 'version-mismatch'
        : states.find((state) => state.kind === 'starting')
          ? 'starting'
          : states.find((state) => state.kind === 'running')
            ? 'running'
            : 'idle';

    switch (worst) {
      case 'crashed':
        this.#item.text = '$(error) Rstack';
        this.#item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.errorBackground',
        );
        break;
      case 'version-mismatch':
        this.#item.text = '$(warning) Rstack';
        this.#item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground',
        );
        break;
      case 'starting':
        this.#item.text = '$(loading~spin) Rstack';
        this.#item.backgroundColor = undefined;
        break;
      default:
        this.#item.text = '$(layers) Rstack';
        this.#item.backgroundColor = undefined;
        break;
    }

    const tooltip = new vscode.MarkdownString(undefined, true);
    // Command links are only rendered in trusted markdown.
    tooltip.isTrusted = true;
    tooltip.appendMarkdown('**Rstack**\n\n');
    for (const stack of STACK_IDS) {
      const state = this.stateOf(stack);
      const links = [`[Output](command:${OUTPUT_COMMANDS[stack]})`];
      const restart = RESTART_COMMANDS[stack];
      if (restart && state.kind !== 'not-detected') {
        links.push(`[Restart](command:${restart})`);
      }
      tooltip.appendMarkdown(
        `${STATE_ICONS[state.kind]} **${STACK_LABELS[stack]}** — ${stateText(
          state,
        )} · ${links.join(' · ')}\n\n`,
      );
    }
    this.#item.tooltip = tooltip;
  }

  dispose(): void {
    this.#item.dispose();
  }
}
