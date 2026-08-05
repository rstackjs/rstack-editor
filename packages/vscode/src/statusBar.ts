import vscode from 'vscode';
import {
  type StackId,
  type StackState,
  type StatusReporter,
  STACK_IDS,
  STACK_LABELS,
  stackCommand,
} from './types';

/**
 * Icon and hover colour per state. `color` is a theme colour id with `.`
 * replaced by `-`, the form VS Code exposes as a CSS variable; the markdown
 * sanitizer accepts `var(--vscode-*)` on a `<span>` and nothing else, so the
 * hover picks up the user's theme instead of hard-coded hexes.
 */
const STATE_STYLES: Readonly<
  Record<StackState['kind'], { readonly icon: string; readonly color: string }>
> = {
  // The two off-states share a glyph but not a colour: nothing found here (the
  // weakest thing on the row) versus somebody turned it off on purpose, which
  // is worth reading. Keep every state on the plain codicon set — glyphs from
  // the debug sets are drawn at their own optical size and stick out.
  'not-detected': { icon: '$(circle-slash)', color: 'disabledForeground' },
  disabled: { icon: '$(circle-slash)', color: 'descriptionForeground' },
  starting: { icon: '$(loading~spin)', color: 'descriptionForeground' },
  running: { icon: '$(check)', color: 'testing-iconPassed' },
  crashed: { icon: '$(error)', color: 'testing-iconFailed' },
  'version-mismatch': {
    icon: '$(warning)',
    color: 'editorWarning-foreground',
  },
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

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The one anchor builder, so escaping is a property of the markup rather than
 * something each call site has to remember. `title` becomes the icon's native
 * tooltip, which is where the wording goes for the icon-only actions.
 */
const anchor = (command: string, body: string, title?: string): string =>
  `<a href="command:${command}"${
    title ? ` title="${escapeAttribute(title)}"` : ''
  }>${body}</a>`;

/**
 * A labelled command as a table row, so its icon lands in the same column as
 * the stack rows'. Icon and label are separate cells and therefore separate
 * anchors to the same command — one `<a>` cannot span two cells.
 */
const actionRow = (command: string, icon: string, label: string): string =>
  `<tr><td>${anchor(command, icon)}</td>` +
  `<td colspan="2">${anchor(command, `&nbsp;${label}`)}</td></tr>`;

/**
 * The single always-present status bar item. It is visible
 * whenever the extension is installed and enabled, even when nothing is
 * detected — it is the answer to "is the extension broken or just idle?".
 *
 * The hover is the only surface: it carries the per-stack state and every
 * action, and clicking the item goes straight to the extension log. There is
 * deliberately no QuickPick behind the item — a menu that repeats what the
 * hover already shows is two renderings of one model, and every peer
 * (Biome, oxc, Prettier) ships exactly one of the two.
 */
export class StatusBar implements vscode.Disposable {
  readonly #item: vscode.StatusBarItem;
  readonly #states = new Map<StackId, StackState>(
    STACK_IDS.map((stack) => [stack, { kind: 'not-detected' }]),
  );
  // Stacks whose controller is currently registered. The restart action tracks
  // this rather than the state kind, which cannot tell "crashed while running"
  // (controller alive, worth rebuilding) from "failed to register" (already
  // disposed, and the reconcile that follows will retry it anyway).
  readonly #active = new Set<StackId>();

  constructor() {
    this.#item = vscode.window.createStatusBarItem(
      'rstack.status',
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.#item.name = 'Rstack';
    // Clicking goes to the extension log, the way Prettier's item does. It is
    // the one action that is useful in every state, including the states where
    // no stack is active and there is nothing else to offer.
    this.#item.command = 'rstack.showOutput';
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

  /** The shell reports controller registration and disposal here. */
  setActive(stack: StackId, active: boolean): void {
    if (active) {
      this.#active.add(stack);
    } else {
      this.#active.delete(stack);
    }
    this.render();
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
        this.#item.text = '$(zap) Rstack';
        this.#item.backgroundColor = undefined;
        break;
    }

    const tooltip = new vscode.MarkdownString(undefined, true);
    // Command links are only rendered in trusted markdown.
    tooltip.isTrusted = true;
    // The stack rows are a raw `<table>` so the three columns line up; markdown
    // has no alignment short of a table with a visible header row, and one row
    // per paragraph left the action icons ragged. Raw html suppresses markdown
    // inside it, so the cells use `<b>`/`<a>` rather than `**`/`[]()` — the
    // sanitizer keeps `command:` hrefs as long as the string stays trusted.
    tooltip.supportHtml = true;
    const rows = STACK_IDS.map((stack) => {
      const state = this.stateOf(stack);
      const style = STATE_STYLES[state.kind];
      const label = STACK_LABELS[stack];
      // The per-stack actions repeat once per row, so they are icon-only: the
      // row already names the stack and the anchor title carries the wording.
      const actions = [
        anchor(
          stackCommand(stack, 'output.focus'),
          '$(selection)',
          `Show the ${label} log`,
        ),
      ];
      if (this.#active.has(stack)) {
        // Titled apart from "Relaunch" below: this one rebuilds only this
        // stack and leaves the others running.
        actions.push(
          anchor(
            stackCommand(stack, 'restart'),
            '$(refresh)',
            `Restart ${label}`,
          ),
        );
      }
      // The state text is the icon's title rather than row text: spelling out
      // "running — 2 folders" on every row is noise once the icon says it, and
      // the details worth reading (a crash message, a version mismatch) are
      // exactly the long ones. `state.detail` is arbitrary text a stack
      // produced, hence the escaping.
      const status =
        `<span title="${escapeAttribute(stateText(state))}" ` +
        `style="color:var(--vscode-${style.color});">${style.icon}</span>`;
      return (
        `<tr><td>${status}</td><td>&nbsp;<b>${label}</b>&nbsp;&nbsp;</td>` +
        `<td align="right">${actions.join('&nbsp;')}</td></tr>`
      );
    });
    // In the same table as the stacks so all six icons share one column; a
    // second table would size its columns independently and the two halves
    // would drift apart. One row per action rather than three across, for the
    // same reason the actions above are icon-only — the hover sizes to its
    // content, so the widest line sets the card's width.
    //
    // Unlike the per-stack restarts, "Relaunch" is unconditional: it is the
    // action for "nothing is active", which is precisely when no per-stack
    // restart is offered.
    const shellActions = [
      actionRow('rstack.restart', '$(debug-restart)', 'Relaunch'),
      actionRow('rstack.showOutput', '$(selection)', 'Extension log'),
      actionRow('rstack.migrateSettings', '$(arrow-right)', 'Migrate settings'),
    ];
    // The gap under the divider is an empty spacer row with an explicit
    // `height`, the one pixel-precise spacing lever sanitized html has left:
    // cell padding is unreachable (`style` survives only on a span, colours
    // only) and everything line-based is quantized to a whole row. An empty
    // cell has no line box, so its `height` is what it says. Above the rule the
    // hover's own `hr { margin-top: 4px }` is enough — and its
    // `margin-bottom: -4px` is why the underside needs the spacer at all.
    const body = [
      ...rows,
      '<tr><td colspan="3"><hr></td></tr>',
      '<tr><td colspan="3" height="4"></td></tr>',
      ...shellActions,
    ].join('');
    tooltip.appendMarkdown(`<table>${body}</table>`);
    this.#item.tooltip = tooltip;
  }

  dispose(): void {
    this.#item.dispose();
  }
}
