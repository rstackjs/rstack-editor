import { type Node, parse } from 'yuku-parser';

export class Range {
  constructor(
    public startLine: number,
    public endLine: number,
    public startChar: number,
    public endChar: number,
  ) {}
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  typeof value.type === 'string';

export const parseTestFile = (
  code: string,
  events: {
    onTest(
      range: Range,
      name: string,
      testType: 'test' | 'it' | 'describe' | 'suite',
    ): (() => void) | void;
  },
) => {
  const result = parse(code, {
    lang: 'tsx',
    preserveParens: false,
    sourceType: 'module',
  });
  const error = result.diagnostics.find(
    (diagnostic) => diagnostic.severity === 'error',
  );
  if (error) {
    throw new SyntaxError(error.message);
  }

  const offsetToRange = (start: number, end: number): Range => {
    const lines = code.substring(0, start).split('\n');
    const startLine = Math.max(0, lines.length - 1);
    const startChar = lines[startLine]?.length || 0;

    const endLines = code.substring(0, end).split('\n');
    const endLine = Math.max(0, endLines.length - 1);
    const endChar = endLines[endLine]?.length || 0;

    return new Range(startLine, endLine, startChar, endChar);
  };

  const getStringLiteralValue = (node: Node | undefined): string | null => {
    if (node?.type === 'Literal' && typeof node.value === 'string') {
      return node.value;
    }
    if (node?.type !== 'TemplateLiteral') {
      return null;
    }

    return node.quasis
      .map((quasi, index) => {
        const expression = index < node.expressions.length ? '${...}' : '';
        return `${quasi.value.cooked ?? quasi.value.raw}${expression}`;
      })
      .join('');
  };

  // Test item names must match runtime `name || '<anonymous>'`. Record bindings
  // in walk order so later calls see assignments without a separate scope pass.
  type Scope = { isFunction: boolean; names: Map<string, string | null> };
  const scopes: Scope[] = [{ isFunction: true, names: new Map() }];
  const functionTypes = new Set([
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
  ]);
  const blockTypes = new Set([
    'BlockStatement',
    'ClassDeclaration',
    'ClassExpression',
    'ForStatement',
    'ForInStatement',
    'ForOfStatement',
    'SwitchStatement',
    'CatchClause',
  ]);

  const scopeOf = (name: string) =>
    scopes.findLast((scope) => scope.names.has(name))?.names;

  const getFunctionName = (
    node: Node | undefined,
    inferred?: string,
  ): string | null => {
    if (
      node?.type === 'FunctionExpression' ||
      node?.type === 'ClassExpression'
    ) {
      return isNode(node.id) && node.id.type === 'Identifier'
        ? node.id.name
        : (inferred ?? '<anonymous>');
    }
    if (node?.type === 'ArrowFunctionExpression') {
      return inferred ?? '<anonymous>';
    }
    if (node?.type === 'Identifier') {
      const names = scopeOf(node.name);
      // Unbound identifiers (including default imports) use a best-effort name;
      // known unknown values must not fall back through a shadowing binding.
      return names ? (names.get(node.name) ?? null) : node.name;
    }
    if (
      node?.type === 'MemberExpression' &&
      !node.computed &&
      node.property.type === 'Identifier'
    ) {
      return node.property.name;
    }
    return null;
  };

  const bind = (pattern: Node, name: string | null, isVar = false): void => {
    if (pattern.type === 'Identifier') {
      const scope = isVar
        ? scopes.findLast((candidate) => candidate.isFunction)
        : scopes.at(-1);
      scope?.names.set(pattern.name, name);
    } else if (pattern.type === 'RestElement') {
      if (isNode(pattern.argument)) {
        bind(pattern.argument, null, isVar);
      }
    } else if (pattern.type === 'AssignmentPattern') {
      if (isNode(pattern.left)) {
        bind(pattern.left, null, isVar);
      }
    } else if (pattern.type === 'ArrayPattern') {
      for (const element of pattern.elements) {
        if (isNode(element)) {
          bind(element, null, isVar);
        }
      }
    } else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        if (!isNode(property)) {
          continue;
        }
        const value =
          property.type === 'RestElement' ? property.argument : property.value;
        if (isNode(value)) {
          bind(value, null, isVar);
        }
      }
    }
  };

  const collectBindings = (node: Node): void => {
    if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) {
        if (!isNode(declaration) || !isNode(declaration.id)) {
          continue;
        }
        const init = isNode(declaration.init) ? declaration.init : undefined;
        if (
          node.kind === 'var' &&
          !init &&
          declaration.id.type === 'Identifier' &&
          scopes
            .findLast((scope) => scope.isFunction)
            ?.names.has(declaration.id.name)
        ) {
          continue;
        }
        const name =
          init && declaration.id.type === 'Identifier'
            ? getFunctionName(init, declaration.id.name)
            : null;
        bind(declaration.id, name, node.kind === 'var');
      }
    } else if (
      node.type === 'AssignmentExpression' &&
      node.operator === '=' &&
      node.left.type === 'Identifier'
    ) {
      // Walking a deferred body must not mutate its enclosing function's names.
      for (let index = scopes.length - 1; index >= 0; index--) {
        const scope = scopes[index];
        if (scope.names.has(node.left.name)) {
          scope.names.set(
            node.left.name,
            getFunctionName(node.right, node.left.name),
          );
          break;
        }
        if (scope.isFunction) {
          break;
        }
      }
    } else if (
      node.type === 'ImportDeclaration' &&
      node.importKind !== 'type' &&
      Array.isArray(node.specifiers)
    ) {
      for (const specifier of node.specifiers) {
        if (!isNode(specifier) || !isNode(specifier.local)) {
          continue;
        }
        if (specifier.type === 'ImportNamespaceSpecifier') {
          bind(specifier.local, null);
        } else if (
          specifier.type === 'ImportSpecifier' &&
          specifier.importKind !== 'type' &&
          isNode(specifier.imported) &&
          specifier.imported.type === 'Identifier'
        ) {
          bind(specifier.local, specifier.imported.name);
        }
      }
    } else if (
      (node.type === 'FunctionDeclaration' ||
        node.type === 'ClassDeclaration') &&
      isNode(node.id) &&
      node.id.type === 'Identifier'
    ) {
      bind(node.id, node.id.name);
    }
  };

  const walkNode = (node: Node): void => {
    collectBindings(node);
    const isFunction = functionTypes.has(node.type);
    const opensScope = isFunction || blockTypes.has(node.type);
    if (opensScope) {
      scopes.push({ isFunction, names: new Map() });
      if (
        (node.type === 'FunctionExpression' ||
          node.type === 'ClassExpression') &&
        isNode(node.id) &&
        node.id.type === 'Identifier'
      ) {
        bind(node.id, node.id.name);
      }
      const params =
        node.type === 'CatchClause'
          ? [node.param]
          : isFunction && 'params' in node && Array.isArray(node.params)
            ? node.params
            : [];
      for (const param of params) {
        if (isNode(param)) {
          bind(param, null);
        }
      }
    }

    let exit: (() => void) | void | undefined;
    let functionTitleNode: Node | undefined;

    if (node.type === 'CallExpression') {
      let functionName: string | undefined;

      if (node.callee.type === 'Identifier') {
        functionName = node.callee.name;
      } else if (
        node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'Identifier'
      ) {
        functionName = node.callee.object.name;
      }

      if (
        functionName === 'test' ||
        functionName === 'it' ||
        functionName === 'describe' ||
        functionName === 'suite'
      ) {
        const title = node.arguments[0];
        if (
          isNode(title) &&
          (title.type === 'FunctionExpression' ||
            title.type === 'ClassExpression' ||
            title.type === 'ArrowFunctionExpression')
        ) {
          functionTitleNode = title;
        }
        exit = events.onTest(
          offsetToRange(node.start, node.end),
          getStringLiteralValue(node.arguments[0]) ||
            getFunctionName(node.arguments[0]) ||
            'unnamed test',
          functionName,
        );
      }
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isNode(child) && child !== functionTitleNode) {
            walkNode(child);
          }
        }
      } else if (isNode(value)) {
        walkNode(value);
      }
    }

    exit?.();
    if (opensScope) {
      scopes.pop();
    }
  };

  walkNode(result.program);
};
