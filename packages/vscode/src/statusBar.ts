import vscode from 'vscode';
import {
  type StackId,
  type StackState,
  type StatusReporter,
  STACK_IDS,
  STACK_LABELS,
  stackCommand,
  stackCommandTitle,
} from './types';

/** The item's resting look: no stack is in a state worth colouring for. */
const IDLE_ITEM_TEXT = '$(zap) Rstack';

/**
 * Icon, hover colour and detail policy per state. `color` is a theme colour id
 * with `.` replaced by `-`, the form VS Code exposes as a CSS variable; the
 * markdown sanitizer accepts `var(--vscode-*)` on a `<span>` and nothing else,
 * so the hover picks up the user's theme instead of hard-coded hexes.
 *
 * `spellsOutDetail` decides whether the state's detail gets its own row in the
 * hover body. It is a property of the state kind rather than of the message,
 * so a state added here has to answer the question once and no call site
 * special-cases a particular status. Say yes for the states the user cannot
 * act on without reading the words ("crashed — <stderr>", "no Node.js 22.18+
 * … is available"); say no for the ones whose detail is progress bookkeeping
 * ("running — 2 folders"), which would otherwise put a second row under every
 * stack in the healthy case and double the card's height for nothing.
 *
 * `severity` ranks the states so the item can show the worst one across stacks,
 * and `item` is how that winner paints itself — absent means the idle look.
 * Both live here rather than in `render` so that a seventh state cannot be
 * added without ranking itself: a nested-ternary ladder over the kinds, which
 * is what this replaced, silently rendered anything it had not heard of as
 * idle.
 */
const STATE_STYLES: Readonly<
  Record<
    StackState['kind'],
    {
      readonly icon: string;
      readonly color: string;
      readonly spellsOutDetail: boolean;
      readonly severity: number;
      readonly item?: {
        readonly text: string;
        readonly background?: string;
      };
    }
  >
> = {
  // The two off-states share a glyph but not a colour: nothing found here (the
  // weakest thing on the row) versus somebody turned it off on purpose, which
  // is worth reading. Keep every state on the plain codicon set — glyphs from
  // the debug sets are drawn at their own optical size and stick out.
  'not-detected': {
    icon: '$(circle-slash)',
    color: 'disabledForeground',
    spellsOutDetail: false,
    severity: 0,
  },
  disabled: {
    icon: '$(circle-slash)',
    color: 'descriptionForeground',
    // "why is nothing happening" is exactly what this row is asked, and the
    // reason (Restricted Mode, a kill switch) is the answer.
    spellsOutDetail: true,
    severity: 0,
  },
  starting: {
    icon: '$(loading~spin)',
    color: 'descriptionForeground',
    spellsOutDetail: false,
    severity: 2,
    item: { text: '$(loading~spin) Rstack' },
  },
  running: {
    icon: '$(check)',
    color: 'testing-iconPassed',
    spellsOutDetail: false,
    // Outranks the off-states so a window with one live stack does not look
    // idle, but carries no `item`: healthy is the idle look.
    severity: 1,
  },
  crashed: {
    icon: '$(error)',
    color: 'testing-iconFailed',
    spellsOutDetail: true,
    severity: 4,
    item: {
      text: '$(error) Rstack',
      background: 'statusBarItem.errorBackground',
    },
  },
  'version-mismatch': {
    icon: '$(warning)',
    color: 'editorWarning-foreground',
    spellsOutDetail: true,
    severity: 3,
    item: {
      // Keeps the idle glyph, unlike every other state that colours the item.
      // A version mismatch is advisory — the run goes ahead — so the amber
      // background is the whole signal; swapping the glyph too reads as
      // "stopped", which is the one thing that has not happened.
      text: IDLE_ITEM_TEXT,
      background: 'statusBarItem.warningBackground',
    },
  },
};

/**
 * Columns in the hover table: the state icon, the label, and one per action
 * slot. The actions get a column each rather than sharing a cell — see the row
 * builder for why that is structural, not cosmetic. The slot count is derived
 * from the widest row of the render in hand rather than pinned to a constant,
 * so an action added to the row builder cannot be dropped off the end of a
 * fixed-width table — a failure whose whole symptom is an icon that never
 * appears.
 */
const tableColumns = (slots: number): number => 2 + slots;

/**
 * The card's width, in CSS px: compact while every stack is quiet, wider when
 * a notice needs room to read. The hover is shrink-to-fit with a 500px cap, so
 * left alone it renders however wide its longest line happens to be — a fixed
 * `width` on the table pins it per state instead. The pin is also what lets
 * the notices live *in* the table: a fixed-width table cannot be stretched by
 * a wide cell (text wraps instead), which is what forced them out of it
 * before. `width` is on the markdown sanitizer's attribute allow-list; a
 * stray unbreakable token (an absolute path) can still widen the table past
 * this, which is accepted — a broken path cannot be copied.
 */
const CARD_WIDTH = 140;
const CARD_WIDTH_WITH_NOTICES = 250;

/**
 * The free text a state carries, if any — a crash message, a version
 * complaint, a disable reason. It is its own function because the hover renders
 * the two halves of a state in different places — the kind is the icon, the
 * detail is prose — and the switch is exhaustive, so a state kind added to the
 * union has to say here whether it carries words.
 */
const stateDetail = (state: StackState): string | undefined => {
  switch (state.kind) {
    case 'not-detected':
      return undefined;
    case 'disabled':
      return state.reason;
    case 'starting':
    case 'running':
    case 'crashed':
    case 'version-mismatch':
      return state.detail;
  }
};

/**
 * The one-line form: the state's kind, plus its detail when it has one. This
 * is what the log records and what the icon's native tooltip says, so its
 * prefix has to stay distinct per kind — `setState` discriminates transitions
 * by this string alone.
 */
const stateText = (state: StackState): string => {
  // The ids read as prose once their hyphen is a space ('version-mismatch' →
  // 'version mismatch'); no kind has a second one.
  const kind = state.kind.replace('-', ' ');
  const detail = stateDetail(state);
  return detail ? `${kind} — ${detail}` : kind;
};

/**
 * One escaper for both positions text can land in — an attribute value and a
 * cell's contents. Quoting `"` is redundant in a cell and escaping `<`/`>` is
 * redundant in an attribute, but a message is attacker-adjacent free text (a
 * tool's stderr, a user's paths) landing in a *trusted* `supportHtml`
 * MarkdownString, so there is exactly one function to get right rather than a
 * pair to pick between under pressure.
 */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * A state's glyph in its state colour — the row's leading cell, and the
 * heading of that state's notice, so the two read as one status rather than as
 * a second opinion. One builder because the colour has to arrive as a `style`
 * on a `<span>`: the markdown sanitizer drops `style` on every other element,
 * and keeps only `color` even here.
 */
const stateIcon = (
  style: (typeof STATE_STYLES)[StackState['kind']],
  title?: string,
): string =>
  `<span${title ? ` title="${escapeHtml(title)}"` : ''} ` +
  `style="color:var(--vscode-${style.color});">${style.icon}</span>`;

/**
 * The one anchor builder, so escaping is a property of the markup rather than
 * something each call site has to remember. `title` becomes the icon's native
 * tooltip, which is where the wording goes for the icon-only actions.
 */
const anchor = (command: string, body: string, title?: string): string =>
  `<a href="command:${command}"${
    title ? ` title="${escapeHtml(title)}"` : ''
  }>${body}</a>`;

/**
 * A labelled command as a table row, so its icon lands in the same column as
 * the stack rows'. Icon and label are separate cells and therefore separate
 * anchors to the same command — one `<a>` cannot span two cells.
 */
const actionRow = (
  columns: number,
  command: string,
  icon: string,
  label: string,
): string =>
  `<tr><td>${anchor(command, icon)}</td>` +
  `<td colspan="${columns - 1}">` +
  `${anchor(command, `&nbsp;${label}`)}</td></tr>`;

/**
 * A rule and the gap under it, between two halves of the card. The gap is an
 * empty spacer row with an explicit `height`, the one pixel-precise spacing
 * lever sanitized html has left: cell padding is unreachable (`style` survives
 * only on a span, colours only) and everything line-based is quantized to a
 * whole row. An empty cell has no line box, so its `height` is what it says.
 * Above the rule the hover's own `hr { margin-top: 4px }` is enough — and its
 * `margin-bottom: -4px` is why the underside needs the spacer at all.
 */
const sectionBreak = (columns: number): string[] => [
  `<tr><td colspan="${columns}"><hr></td></tr>`,
  `<tr><td colspan="${columns}" height="4"></td></tr>`,
];

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

  readonly #output: vscode.LogOutputChannel;

  constructor(output: vscode.LogOutputChannel) {
    this.#output = output;
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
    // Transitions go to the shell log so the hover's icon always has a written
    // "why" behind it. Same-text repeats are dropped: a stack re-reporting its
    // current state (e.g. `running` after every format) is not a transition,
    // and an identical text also renders identically, so the rebuild is
    // skipped along with the log line. Text alone discriminates the state:
    // every kind has a distinct `stateText` prefix.
    const text = stateText(state);
    const unchanged = text === stateText(this.stateOf(stack));
    this.#states.set(stack, state);
    if (unchanged) {
      return;
    }
    this.#output.info(`${STACK_LABELS[stack]} status: ${text}`);
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
    // `STACK_IDS` is a non-empty tuple, so the seedless reduce cannot throw.
    // Ties keep the earliest stack, matching the `find`-per-kind ladder this
    // replaced.
    const states = STACK_IDS.map((stack) => this.stateOf(stack));
    const worst = states.reduce((a, b) =>
      STATE_STYLES[b.kind].severity > STATE_STYLES[a.kind].severity ? b : a,
    );
    const item = STATE_STYLES[worst.kind].item;
    this.#item.text = item?.text ?? IDLE_ITEM_TEXT;
    this.#item.backgroundColor = item?.background
      ? new vscode.ThemeColor(item.background)
      : undefined;

    const tooltip = new vscode.MarkdownString(undefined, true);
    // Command links are only rendered in trusted markdown.
    tooltip.isTrusted = true;
    // The stack rows are a raw `<table>` so the three columns line up; markdown
    // has no alignment short of a table with a visible header row, and one row
    // per paragraph left the action icons ragged. Raw html suppresses markdown
    // inside it, so the cells use `<b>`/`<a>` rather than `**`/`[]()` — the
    // sanitizer keeps `command:` hrefs as long as the string stays trusted.
    tooltip.supportHtml = true;
    // Messages worth reading, collected while the rows are built and rendered
    // under their own section break at the bottom — the whole point of showing
    // them at all, rather than in a nested `title` nobody hovers twice to read.
    // The state itself is carried, not its markup: everything the card renders
    // is built in one place, below.
    const notices: {
      style: (typeof STATE_STYLES)[StackState['kind']];
      label: string;
      detail: string;
    }[] = [];
    // Cells first, rows second: the column count is a property of the whole
    // render, so every row has to be known before any of them can be written.
    const cells = STACK_IDS.map((stack, index) => {
      const state = states[index] ?? { kind: 'not-detected' as const };
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
            stackCommandTitle(stack),
          ),
        );
      }
      // The state text stays on the icon's title so every row, including the
      // ones whose detail is not spelled out below, can still be read in full.
      // `stateText` embeds arbitrary text a stack produced, hence the escaping.
      const status = stateIcon(style, stateText(state));
      const detail = style.spellsOutDetail
        ? stateDetail(state)?.trim()
        : undefined;
      if (detail) {
        notices.push({ style, label, detail });
      }
      return { status, label, actions };
    });
    const slots = Math.max(...cells.map(({ actions }) => actions.length));
    const columns = tableColumns(slots);
    const rows = cells.map(({ status, label, actions }) => {
      // `width="100%"` on the label cell makes it absorb the table's slack, so
      // the actions stay pinned to the card's right edge instead of drifting
      // inwards once the notice below widens the card.
      //
      // One column per action, rather than both icons in one cell. That is
      // structural: claiming the slack squeezes every other column to its
      // min-content width, and the hover's `overflow-wrap` makes that one icon
      // wide — so two icons sharing a cell wrapped onto two lines and doubled
      // the row's height, which `&nbsp;` does not prevent and which sanitized
      // html cannot fix from the outside (`nowrap` is not on the attribute
      // allow-list, and `style` survives only on a `<span>`, colours only). A
      // cell holding a single inline element has no break opportunity at all,
      // so the question stops being how narrow the column may get.
      const actionCells = Array.from(
        { length: slots },
        (_, index) => `<td align="right">${actions[index] ?? ''}</td>`,
      );
      return (
        `<tr><td>${status}</td>` +
        `<td width="100%">&nbsp;<b>${label}</b>&nbsp;&nbsp;</td>` +
        `${actionCells.join('')}</tr>`
      );
    });
    // In the same table as the stacks so all five icons share one column; a
    // second table would size its columns independently and the two halves
    // would drift apart. One row per action rather than two across, because
    // two labelled actions do not fit across a card this narrow — they would
    // wrap, and a wrapped row of links reads as one ragged paragraph.
    //
    // Unlike the per-stack restarts, "Relaunch" is unconditional: it is the
    // action for "nothing is active", which is precisely when no per-stack
    // restart is offered.
    const shellActions = [
      actionRow(columns, 'rstack.restart', '$(debug-restart)', 'Relaunch'),
      actionRow(columns, 'rstack.showOutput', '$(selection)', 'Extension log'),
    ];
    const body = [...rows, ...sectionBreak(columns), ...shellActions];
    // The notices sit under their own divider, one full-width cell each. Named
    // by their stack, because down here a message has lost the row it belonged
    // to. No hand-wrapping: the fixed table width is what the text wraps to,
    // and the renderer places the breaks. Only the line breaks the message
    // itself wrote — a stack trace, a numbered remedy — are kept, as `<br>`.
    if (notices.length > 0) {
      body.push(
        ...sectionBreak(columns),
        ...notices.map(({ style, label, detail }) => {
          const prose = escapeHtml(detail.replace(/\r\n/g, '\n'))
            .split('\n')
            .join('<br>');
          return (
            `<tr><td colspan="${columns}">` +
            `${stateIcon(style)}&nbsp;<b>${label}</b><br>${prose}</td></tr>`
          );
        }),
      );
    }
    const width = notices.length > 0 ? CARD_WIDTH_WITH_NOTICES : CARD_WIDTH;
    tooltip.appendMarkdown(`<table width="${width}">${body.join('')}</table>`);
    this.#item.tooltip = tooltip;
  }

  dispose(): void {
    this.#item.dispose();
  }
}
