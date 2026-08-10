/**
 * The hover markup is the unit under test. It is html assembled by hand into a
 * *trusted* `MarkdownString`, so the assertions here are deliberately about the
 * literal string: which rows exist, and what a stack's free-text detail looks
 * like once it has been through the escaper. `vscode` is stubbed down to the
 * four things the status bar touches — unit tests run in plain Node, and E2E
 * stays the ground truth for how the card actually renders.
 */
import { beforeEach, describe, expect, it, rs } from '@rstest/core';
import type vscode from 'vscode';

interface FakeItem {
  name: string;
  text: string;
  tooltip: { value: string; isTrusted: boolean; supportHtml: boolean } | null;
  command: string;
  backgroundColor: { id: string } | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

const harness = rs.hoisted(() => ({ items: [] as FakeItem[] }));

rs.mock('vscode', () => {
  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class {
      constructor(readonly id: string) {}
    },
    MarkdownString: class {
      value: string;
      isTrusted = false;
      supportHtml = false;
      constructor(value?: string) {
        this.value = value ?? '';
      }
      appendMarkdown(text: string): this {
        this.value += text;
        return this;
      }
    },
    window: {
      createStatusBarItem: (): FakeItem => {
        const item: FakeItem = {
          name: '',
          text: '',
          tooltip: null,
          command: '',
          backgroundColor: undefined,
          show: () => undefined,
          hide: () => undefined,
          dispose: () => undefined,
        };
        harness.items.push(item);
        return item;
      },
    },
  };
  return { ...vscode, default: vscode };
});

import { StatusBar } from '../src/statusBar';

/** The status bar only ever logs transitions, so a sink is enough. */
const output = {
  info: () => undefined,
} as unknown as vscode.LogOutputChannel;

const rowsOf = (html: string): string[] =>
  html
    .split('<tr>')
    .slice(1)
    .map((row) => row.split('</tr>')[0] ?? '');

/**
 * The notice rows: everything under the second divider, spacer skipped. An
 * empty array while every stack is quiet — the divider itself only appears
 * with something to put under it.
 */
const noticesOf = (html: string): string[] => {
  const rows = rowsOf(html);
  const dividers = rows.flatMap((row, i) => (row.includes('<hr>') ? [i] : []));
  const second = dividers[1];
  return second === undefined ? [] : rows.slice(second + 2);
};

/** The rows of the stack half — everything above the divider. */
const stackRows = (html: string): string[] => {
  const rows = rowsOf(html);
  const divider = rows.findIndex((row) => row.includes('<hr>'));
  return rows.slice(0, divider);
};

const build = (): { bar: StatusBar; html: () => string } => {
  const bar = new StatusBar(output);
  const item = harness.items.at(-1);
  if (!item) {
    throw new Error('no status bar item was created');
  }
  return { bar, html: () => item.tooltip?.value ?? '' };
};

beforeEach(() => {
  harness.items.length = 0;
});

describe('StatusBar hover', () => {
  it('shows one row per stack and the shell actions when nothing is detected', () => {
    const { html } = build();
    expect(stackRows(html())).toHaveLength(3);
    // Divider, spacer, and the three shell actions still follow the stacks.
    expect(rowsOf(html())).toHaveLength(8);
    expect(html()).toContain('command:rstack.restart');
    expect(html()).toContain('command:rstack.showOutput');
    expect(html()).toContain('command:rstack.migrateSettings');
  });

  it('spells a failure message out below the table, named by its stack', () => {
    const { bar, html } = build();
    bar.setState('rstest', {
      kind: 'version-mismatch',
      detail:
        'No Node.js >=22.18.0 is available to run tests. Tests will not run.',
    });
    // In the table, but under its own divider — and it cannot stretch the
    // rows above it, because the table's width is pinned. One cell, left for
    // the renderer to wrap at the card's edge; no hand-wrapping.
    const rows = stackRows(html());
    expect(rows).toHaveLength(3);
    // Three columns, not four: no stack is active here, so no row carries a
    // restart icon and the table is one slot narrower.
    expect(noticesOf(html())).toEqual([
      '<td colspan="3">' +
        '<span style="color:var(--vscode-editorWarning-foreground);">' +
        '$(warning)</span>&nbsp;<b>Rstest</b><br>' +
        'No Node.js &gt;=22.18.0 is available to run tests. ' +
        'Tests will not run.</td>',
    ]);
    // A notice widens the card; quiet again, it narrows back.
    expect(html()).toContain('<table width="250">');
    bar.setState('rstest', { kind: 'running' });
    expect(html()).toContain('<table width="140">');
    bar.setState('rstest', {
      kind: 'version-mismatch',
      detail:
        'No Node.js >=22.18.0 is available to run tests. Tests will not run.',
    });
    // The icon and its warning colour are untouched.
    expect(rows[1]).toContain('<b>Rstest</b>');
    expect(rows[1]).toContain('$(warning)');
    expect(rows[1]).toContain('color:var(--vscode-editorWarning-foreground);');
  });

  it('gives every action its own cell, so no row can wrap', () => {
    // The hover's `overflow-wrap` computes a squeezed column's minimum as one
    // icon wide, so two icons sharing a cell broke onto two lines. One icon per
    // cell leaves no break opportunity at all — the width of the column stops
    // mattering. The label cell still claims the slack, to keep the actions
    // pinned to the card's right edge.
    const { bar, html } = build();
    bar.setActive('rstest', true);
    const row = stackRows(html())[1] ?? '';
    expect(html()).toContain('<table width="140">');
    expect(row).toContain('<td width="100%">');
    // Two action cells, and neither holds more than a single anchor.
    const cells = row.split('<td align="right">').slice(1);
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.split('</a>').length - 1).toBeLessThanOrEqual(1);
    }
    // Rows keep their column count when a stack has only one action.
    const idle = stackRows(html())[0] ?? '';
    expect(idle.split('<td align="right">')).toHaveLength(3);
  });

  it('sizes the table to the widest row, not to a fixed slot count', () => {
    // The column count is derived so an action added to the row builder cannot
    // be silently dropped off the end of a fixed-width table.
    const { bar, html } = build();
    const slotsOf = (row: string) => row.split('<td align="right">').length - 1;
    expect(stackRows(html()).map(slotsOf)).toEqual([1, 1, 1]);
    expect(html()).toContain('colspan="3"');
    // One active stack widens every row, so the columns stay aligned.
    bar.setActive('fmt', true);
    expect(stackRows(html()).map(slotsOf)).toEqual([2, 2, 2]);
    expect(html()).toContain('colspan="4"');
  });

  it('keeps the per-stack actions in the table, not in the notice', () => {
    const { bar, html } = build();
    bar.setActive('rstest', true);
    bar.setState('rstest', { kind: 'crashed', detail: 'worker exited' });
    expect(stackRows(html())[1]).toContain(
      'command:rstack.rstest.output.focus',
    );
    expect(stackRows(html())[1]).toContain('command:rstack.rstest.restart');
    expect(noticesOf(html())[0]).toContain(
      '$(error)</span>&nbsp;<b>Rstest</b><br>worker exited</td>',
    );
  });

  it('escapes the message everywhere it lands in the markup', () => {
    const { bar, html } = build();
    bar.setState('rslint', {
      kind: 'crashed',
      detail: '<img src=x onerror="alert(1)"> failed at a>b && c',
    });
    const escaped =
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; failed at a&gt;b ' +
      '&amp;&amp; c';
    // Both the prose notice and the icon's title attribute, which the message
    // also reaches through `stateText`.
    expect(stackRows(html())[0]).toContain(`title="crashed — ${escaped}"`);
    expect(noticesOf(html())[0]).toContain(`<b>Rslint</b><br>${escaped}`);
    expect(html()).not.toContain('<img');
    expect(html()).not.toContain('onerror="alert(1)"');
  });

  it('leaves markdown punctuation alone inside the table', () => {
    // The whole card is one html block, and markdown-it does not run inline
    // markdown inside an html block — so underscores and asterisks need no
    // backslashes, and adding them would render them.
    const { bar, html } = build();
    bar.setState('rslint', {
      kind: 'crashed',
      detail: 'cannot read __tests__/a_b.ts or *.config.*',
    });
    expect(noticesOf(html())[0]).toContain(
      'cannot read __tests__/a_b.ts or *.config.*',
    );
  });

  it('keeps a multi-line message on multiple lines', () => {
    const { bar, html } = build();
    bar.setState('fmt', {
      kind: 'crashed',
      detail: '  rs fmt exited with 1\nstderr: broken config\n',
    });
    // Trimmed, so a message ending in a newline does not draw a blank line;
    // inside a cell the message's own breaks become `<br>`.
    expect(noticesOf(html())[0]).toContain(
      '<b>rs fmt</b><br>rs fmt exited with 1<br>stderr: broken config',
    );
  });

  it('gives a stack with no message no extra row', () => {
    const { bar, html } = build();
    // `running — 2 folders` is bookkeeping: it stays on the icon's title.
    bar.setState('rslint', { kind: 'running', detail: '2 folders' });
    bar.setState('rstest', { kind: 'starting' });
    bar.setState('fmt', { kind: 'disabled' });
    const rows = stackRows(html());
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('title="running — 2 folders"');
    // `disabled` does spell its reason out — when it has one. Absent, it must
    // not leave a stray notice (or its divider) behind.
    expect(noticesOf(html())).toEqual([]);
    expect(rowsOf(html())).toHaveLength(8);
  });

  it('spells out why a stack was deliberately turned off', () => {
    const { bar, html } = build();
    bar.setState('fmt', {
      kind: 'disabled',
      reason: 'Restricted Mode: no processes are spawned',
    });
    expect(noticesOf(html())[0]).toContain(
      '<b>rs fmt</b><br>Restricted Mode: no processes are spawned',
    );
  });

  it('leaves a long message unbroken for the cell to wrap', () => {
    // The fixed table width is what the text wraps to, and the renderer
    // places the breaks; inserting them here would put them somewhere the
    // renderer has not measured.
    const path =
      '/Users/somebody/very/deeply/nested/workspace/packages/app/rstest.config.ts';
    const { bar, html } = build();
    bar.setState('rstest', { kind: 'crashed', detail: `cannot read ${path}` });
    expect(noticesOf(html())[0]).toContain(`<br>cannot read ${path}</td>`);
  });

  it('keeps the hover trusted html, which is what makes escaping load-bearing', () => {
    build();
    const tooltip = harness.items.at(-1)?.tooltip;
    expect(tooltip?.isTrusted).toBe(true);
    expect(tooltip?.supportHtml).toBe(true);
  });
});

/**
 * The item itself, not the hover. Its look is the worst state across the
 * stacks, which is the one thing a user sees without hovering at all.
 */
describe('StatusBar item', () => {
  const itemOf = () => {
    const item = harness.items.at(-1);
    if (!item) {
      throw new Error('no status bar item was created');
    }
    return item;
  };

  it('is idle when nothing is detected', () => {
    build();
    expect(itemOf().text).toBe('$(zap) Rstack');
    expect(itemOf().backgroundColor).toBeUndefined();
  });

  it('colours for a version mismatch but keeps the idle glyph', () => {
    // The mismatch is advisory — the run goes ahead — so the amber background
    // carries it alone. An `$(warning)` glyph here would read as "stopped".
    const { bar } = build();
    bar.setState('rstest', { kind: 'version-mismatch', detail: 'old node' });
    expect(itemOf().text).toBe('$(zap) Rstack');
    expect(itemOf().backgroundColor?.id).toBe(
      'statusBarItem.warningBackground',
    );
  });

  it('lets a crash outrank a mismatch', () => {
    const { bar } = build();
    bar.setState('rstest', { kind: 'version-mismatch', detail: 'old node' });
    bar.setState('rslint', { kind: 'crashed', detail: 'server died' });
    expect(itemOf().text).toBe('$(error) Rstack');
    expect(itemOf().backgroundColor?.id).toBe('statusBarItem.errorBackground');
  });

  it('lets a mismatch outrank a healthy sibling', () => {
    // Same glyph as healthy, so the background is what tells them apart.
    const { bar } = build();
    bar.setState('rslint', { kind: 'running', detail: '2 folders' });
    bar.setState('fmt', { kind: 'running' });
    bar.setState('rstest', { kind: 'version-mismatch', detail: 'old node' });
    expect(itemOf().backgroundColor?.id).toBe(
      'statusBarItem.warningBackground',
    );
  });

  it('stays idle-looking while healthy', () => {
    const { bar } = build();
    bar.setState('rslint', { kind: 'running', detail: '2 folders' });
    expect(itemOf().text).toBe('$(zap) Rstack');
    expect(itemOf().backgroundColor).toBeUndefined();
  });
});
