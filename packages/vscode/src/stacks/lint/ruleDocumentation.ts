const RULE_DOCS_BASE_URL = 'https://rslint.rs/rules';

/** Derives a best-effort Rule docs link without validating the rule id. */
export function ruleDocsUrl(ruleId: string): string {
  const separator = ruleId.lastIndexOf('/');
  if (separator === -1) {
    return `${RULE_DOCS_BASE_URL}/eslint/${ruleId}`;
  }

  const prefix = ruleId.slice(0, separator).replace(/^@/, '');
  const ruleName = ruleId.slice(separator + 1);
  return `${RULE_DOCS_BASE_URL}/${prefix}/${ruleName}`;
}
