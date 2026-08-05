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

const RESTART_COMMANDS: Readonly<Record<StackId, string>> = {
  rslint: 'rstack.rslint.restart',
  rstest: 'rstack.rstest.restart',
  fmt: 'rstack.fmt.restart',
};

/**
 * Icon and hover colour per state. `color` is a theme colour id with `.`
 * replaced by `-`, the form VS Code exposes as a CSS variable; the markdown
 * sanitizer accepts `var(--vscode-*)` on a `<span>` and nothing else, so the
 * hover picks up the user's theme instead of hard-coded hexes.
 */
const STATE_STYLES: Readonly<
  Record<StackState['kind'], { readonly icon: string; readonly color: string }>
> = {
  // The two off-states share a glyph but not a colour: nothing was found for
  // this workspace (the weakest thing on the row — `disabledForeground` is the
  // colour VS Code reserves for "not available") versus somebody turned it off
  // on purpose, which is worth actually reading. Glyphs from other icon sets
  // (the debug breakpoints, say) are drawn at their own optical size and stand
  // out of a row of plain codicons — keep every state on one set.
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

/** An icon-only command link, with the wording moved to its native tooltip. */
const action = (command: string, title: string, icon: string): string =>
  `<a href="command:${command}" title="${escapeAttribute(title)}">${icon}</a>`;

/**
 * A labelled command as a table row, so its icon lands in the same column as
 * the stack rows'. Icon and label are separate cells and therefore separate
 * links to the same command — one `<a>` cannot span two cells.
 */
const link = (command: string, icon: string, label: string): string => {
  const href = `<a href="command:${command}">`;
  return `<tr><td>${href}${icon}</a></td><td colspan="2">${href}&nbsp;${label}</a></td></tr>`;
};

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

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
  // Stacks whose controller is currently registered. Restart availability
  // tracks this, not the state kind: a state cannot distinguish "crashed
  // while running" (controller alive, its restart command exists) from
  // "failed to register" (controller disposed, the command with it), and a
  // disabled stack never registered the command at all.
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

  #canRestart(stack: StackId): boolean {
    return this.#active.has(stack);
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
      // row already names the stack, and the link title carries the wording for
      // anyone who hovers the icon. The global row below stays text — it
      // appears once and has no row label to lean on.
      const actions = [
        action(OUTPUT_COMMANDS[stack], `Show the ${label} log`, '$(selection)'),
      ];
      if (this.#canRestart(stack)) {
        // Titled apart from "Relaunch extension" below: this one rebuilds only
        // this stack and leaves the others running.
        actions.push(
          action(RESTART_COMMANDS[stack], `Restart ${label}`, '$(refresh)'),
        );
      }
      // The state text is the icon's title rather than row text: spelling out
      // "running — 2 folders" on every row is mostly noise once the icon says
      // it, and the details worth reading (a crash message, a version
      // mismatch) are exactly the long ones. `state.detail` is arbitrary text a
      // stack produced, hence the escaping.
      // Icon size is not adjustable here: the hover renders codicons at
      // `font-size: inherit` and the sanitizer drops `font-size` from a span's
      // style, leaving heading tags as the only lever — and those carry the
      // hover's `h1-h6 { margin: 8px 0 }`, which pads out every row. Not worth
      // it; the icons stay at the row's own size.
      const status =
        `<span title="${escapeAttribute(stateText(state))}" ` +
        `style="color:var(--vscode-${style.color});">${style.icon}</span>`;
      // The table stays sized to its content. Stretching it with
      // `width="100%"` does push the actions to the card's edge, but the card
      // is as wide as the widest line below, so the row ends up mostly gap and
      // the action cell gets squeezed until its two icons wrap onto separate
      // lines. Right-aligning inside the natural column is as far as this goes.
      return (
        `<tr><td>${status}</td><td>&nbsp;<b>${label}</b>&nbsp;&nbsp;</td>` +
        `<td align="right">${actions.join('&nbsp;')}</td></tr>`
      );
    });
    // Same table as the stacks, so all six icons share one column and one gap
    // to their label. A second table (or a markdown paragraph) would size its
    // columns independently and the two halves would drift apart.
    //
    // One row per action rather than three across: the hover has no width of
    // its own, it sizes to its content, so three labelled actions on one line
    // set the card's width and leave the rows above swimming in it.
    //
    // Unlike the per-stack restarts, "Relaunch" is unconditional: it is the
    // action for "nothing is active", which is precisely when no per-stack
    // restart is offered.
    const global = [
      link('rstack.restart', '$(debug-restart)', 'Relaunch'),
      link('rstack.showOutput', '$(selection)', 'Extension log'),
      link('rstack.migrateSettings', '$(arrow-right)', 'Migrate settings'),
    ];
    tooltip.appendMarkdown(
      `<table>${rows.join('')}` +
        // The gap under the divider is an *empty* spacer row with an explicit
        // `height` — the one pixel-precise spacing lever in sanitized html.
        // Everything line-based was tried and is quantized to a full row: cell
        // padding is unreachable (the sanitizer keeps `style` only on a span,
        // colours only), a `<br>` costs a line-height (too much), no spacer
        // leaves the hover's `hr { margin-bottom: -4px }` hugging the next row
        // (too little), and shrinking a blank line with `<small>` does nothing
        // because the cell's own strut keeps the line box at the td's
        // font-height. An empty cell has no line box at all, so its `height`
        // attribute (allowlisted) is what it says. Above the rule the hr's own
        // 4px top margin is enough.
        '<tr><td colspan="3"><hr></td></tr>' +
        '<tr><td colspan="3" height="4"></td></tr>' +
        `${global.join('')}</table>`,
    );
    this.#item.tooltip = tooltip;
  }

  dispose(): void {
    this.#item.dispose();
  }
}
