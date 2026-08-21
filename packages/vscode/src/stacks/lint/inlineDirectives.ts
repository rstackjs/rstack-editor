export interface InlineDirectiveRuleToken {
  readonly ruleId: string;
  /** UTF-16 offset of the first character in the rule id. */
  readonly start: number;
  /** UTF-16 offset immediately after the rule id. */
  readonly end: number;
}

// This intentionally scans raw text, so comment-shaped string, template, or
// regex literals whose body starts with an Inline directive are false positives.
// A language-aware scanner is disproportionate for a hover/underline affordance;
// requiring the directive as the first token keeps the accepted surface tiny.
const COMMENT_PATTERN = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
const DIRECTIVE_PATTERN =
  /^\s*(?:rslint|eslint)-(?:disable-next-line|disable-line|disable|enable)(?=\s|$)/;
const DESCRIPTION_SEPARATOR = ' -- ';

/**
 * Finds the rule-id tokens carried by Inline directives in source comments.
 * A bare directive represents every rule and therefore yields no tokens.
 */
export function parseInlineDirectiveRuleTokens(
  source: string,
): InlineDirectiveRuleToken[] {
  const tokens: InlineDirectiveRuleToken[] = [];

  for (const comment of source.matchAll(COMMENT_PATTERN)) {
    const commentText = comment[0];
    const markerLength = 2;
    const closingLength = commentText.startsWith('/*') ? 2 : 0;
    const body = commentText.slice(
      markerLength,
      commentText.length - closingLength,
    );
    const directive = DIRECTIVE_PATTERN.exec(body);
    if (!directive) continue;

    const rulesStartInBody = directive[0].length;
    const remainder = body.slice(rulesStartInBody);
    const ruleList = remainder.split(DESCRIPTION_SEPARATOR)[0];
    const ruleListStart =
      (comment.index ?? 0) + markerLength + rulesStartInBody;

    let segmentStart = 0;
    for (const segment of ruleList.split(',')) {
      const leadingWhitespace = segment.length - segment.trimStart().length;
      const ruleId = segment.trim();
      // Rule ids are comma-separated. Internal whitespace means this segment
      // is not a rule-id token, but the id is deliberately not checked against
      // any bundled rule knowledge.
      if (ruleId.length > 0 && !/\s/.test(ruleId)) {
        const start = ruleListStart + segmentStart + leadingWhitespace;
        tokens.push({ ruleId, start, end: start + ruleId.length });
      }
      segmentStart += segment.length + 1;
    }
  }

  return tokens;
}
