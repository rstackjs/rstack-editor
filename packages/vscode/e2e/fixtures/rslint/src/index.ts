// This fixture doubles as the F5 playground: open this file in the dev host
// and every lint capability of the extension is observable directly below.
// Constraint: the smoke test asserts on `local/no-null` — keep exactly one
// `null` literal in this file.

// #region Diagnostics — clickable rule docs in the Problems panel
// Every rslint diagnostic in the Problems panel (Cmd+Shift+M) shows its rule
// id as a clickable link, and the message carries no `[rule-id]` prefix — the
// extension lifts the id into the diagnostic's code.

// `local/no-null` is this fixture's own plugin rule (see local-plugin.mjs).
// Its derived docs link is a deliberate 404: a user-local rule has no page on
// rslint.rs. This is the diagnostic the smoke test asserts on.
export function getValue() {
  return null;
}

// Native rules link to real pages: `no-console` → /rules/eslint/no-console,
// `@typescript-eslint/no-explicit-any` → /rules/typescript-eslint/no-explicit-any.
export function debugValue(value: any) {
  console.log(value);
}
// #endregion

// #region Inline directives — hover, underline, Ctrl+click
// Rule ids inside a disable comment are underlined. Hovering one shows
// `Rslint(rule-id)` with the id linking to its docs page; Ctrl+click
// (Cmd+click on macOS) opens the page directly. The directive keyword itself
// has no hover — only the rule ids do.

// rslint-disable-next-line no-console
console.log('suppressed — hover the underlined rule id above');

// Comma-separated ids are each their own hover target; the ` -- ` trailer is
// free-form description and is not parsed.
// rslint-disable-next-line no-console, @typescript-eslint/no-explicit-any -- demo: two rule ids and a trailer
export const logAny = (value: any) => console.log(value);
// #endregion

// #region Directive forms — disable-line, eslint- prefix, wildcard
// `rslint-disable-line` suppresses its own line, and works from a trailing
// comment too.
console.log('suppressed inline'); // rslint-disable-line no-console

// The `eslint-` prefix is an exact equivalent of `rslint-`.
// eslint-disable-next-line no-console
console.log('suppressed via the eslint- prefix');

// A bare directive suppresses every rule; with no rule id there is nothing to
// hover.
// rslint-disable-next-line
console.log('suppressed by the wildcard directive');
// #endregion

// #region Pitfall — a mistyped rule id
// A mistyped id suppresses nothing: the squiggle below survives, which is the
// signal the directive missed. Its hover link still derives (and 404s) — the
// extension deliberately validates nothing against a rule list (ADR 0004).
// rslint-disable-next-line no-consle
console.log('NOT suppressed — the rule id above is mistyped');
// #endregion
