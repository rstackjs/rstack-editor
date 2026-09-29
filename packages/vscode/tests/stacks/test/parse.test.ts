import fs from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@rstest/core';
import { parseTestFile, type Range } from '../../../src/stacks/test/parserTest';

describe('parseTestFile', () => {
  it('should detect nested describe and test blocks', () => {
    const code = `
      describe('outer', () => {
        it('inner test', () => {});
        test('another inner test', () => {});
        describe('inner describe', () => {
          test('deeply nested test', () => {});
        });
      });
    `;

    const tests: { name: string; type: string }[] = [];
    parseTestFile(code, {
      onTest: (
        _range: Range,
        name: string,
        testType: 'test' | 'it' | 'describe' | 'suite',
      ) => {
        tests.push({ name, type: testType });
      },
    });

    // The order of discovery is not guaranteed to be in source order, so we sort.
    tests.sort((a, b) => a.name.localeCompare(b.name));

    expect(tests.map((t) => t.name)).toEqual([
      'another inner test',
      'deeply nested test',
      'inner describe',
      'inner test',
      'outer',
    ]);

    expect(tests.map((t) => t.type)).toEqual([
      'test',
      'test',
      'describe',
      'it',
      'describe',
    ]);
  });

  it('should handle template literals in test names', () => {
    const code = `
      const a = 'a';
      describe(\`outer \${a}\`, () => {
        it('inner test', () => {});
      });
    `;

    const tests: { name: string; type: string }[] = [];
    parseTestFile(code, {
      onTest: (
        _range: Range,
        name: string,
        testType: 'test' | 'it' | 'describe' | 'suite',
      ) => {
        tests.push({ name, type: testType });
      },
    });

    tests.sort((a, b) => a.name.localeCompare(b.name));

    expect(tests.map((t) => t.name)).toEqual(['inner test', 'outer ${...}']);
  });

  it('should detect .only, .skip and .todo variants', () => {
    const code = `
      describe.skip('skipped describe', () => {
        it('inner', () => {});
      });
      test.only('focused test', () => {});
      test["only"]('computed only', () => {});
      test.todo('has todo');
    `;

    const tests: { name: string; type: string }[] = [];
    parseTestFile(code, {
      onTest: (
        _range: Range,
        name: string,
        testType: 'test' | 'it' | 'describe' | 'suite',
      ) => {
        tests.push({ name, type: testType });
      },
    });

    tests.sort((a, b) => a.name.localeCompare(b.name));

    expect(tests.map((t) => t.name)).toEqual([
      'computed only',
      'focused test',
      'has todo',
      'inner',
      'skipped describe',
    ]);
    expect(tests.map((t) => t.type)).toEqual([
      'test',
      'test',
      'test',
      'it',
      'describe',
    ]);
  });

  it('should detect suite blocks', () => {
    const code = `
      suite('root suite', () => {
        test('child test', () => {});
      });
    `;

    const tests: { name: string; type: string }[] = [];
    parseTestFile(code, {
      onTest: (
        _range: Range,
        name: string,
        testType: 'test' | 'it' | 'describe' | 'suite',
      ) => {
        tests.push({ name, type: testType });
      },
    });

    tests.sort((a, b) => a.name.localeCompare(b.name));

    expect(tests.map((t) => t.name)).toEqual(['child test', 'root suite']);
    expect(tests.map((t) => t.type)).toEqual(['test', 'suite']);
  });

  it('should label anonymous function names and mark other dynamic names as "unnamed test"', () => {
    const code = `
      const title = getTitle();
      function getTitle() { return 'x'; }
      test(title as any, () => {});
      it(123 as any, () => {});
      describe(() => {}, () => {});
      suite((() => 'x') as any, () => {});
      test(() => {});
    `;

    const tests: { name: string; type: string }[] = [];
    parseTestFile(code, {
      onTest: (
        _range: Range,
        name: string,
        testType: 'test' | 'it' | 'describe' | 'suite',
      ) => {
        tests.push({ name, type: testType });
      },
    });

    expect(tests.map((test) => test.name).sort()).toEqual([
      '<anonymous>',
      '<anonymous>',
      'unnamed test',
      'unnamed test',
      'unnamed test',
    ]);
  });

  it('should use function and class names from expressions and identifiers', () => {
    const code = `
      function Component() {}
      const ArrowComponent = () => {};
      class Widget {}
      const NamedWidget = class InternalWidget {};
      test(Component, () => {});
      it(ArrowComponent, () => {});
      describe(Widget, () => {});
      suite(NamedWidget, () => {});
      test(function DirectFunction() {}, () => {});
      describe(class DirectClass {}, () => {});
    `;

    const tests: { name: string; type: string }[] = [];
    parseTestFile(code, {
      onTest: (
        _range: Range,
        name: string,
        testType: 'test' | 'it' | 'describe' | 'suite',
      ) => {
        tests.push({ name, type: testType });
      },
    });

    tests.sort((a, b) => a.name.localeCompare(b.name));

    expect(tests.map((test) => test.name)).toEqual([
      'ArrowComponent',
      'Component',
      'DirectClass',
      'DirectFunction',
      'InternalWidget',
      'Widget',
    ]);
  });

  it('should resolve function names in the nearest lexical scope', () => {
    const code = `
      function Component() {}
      test(Component, () => {});
      {
        const Component = function InnerComponent() {};
        test(Component, () => {});
      }
      test(Component, () => {});
    `;

    const names: string[] = [];
    parseTestFile(code, {
      onTest: (_range, name) => {
        names.push(name);
      },
    });

    expect(names.sort()).toEqual(['Component', 'Component', 'InnerComponent']);
  });

  it('should use imported names for named function bindings', () => {
    const code = `
      import { Component, Original as Local } from './component';
      test(Component, () => {});
      it(Local, () => {});
    `;

    const names: string[] = [];
    parseTestFile(code, {
      onTest: (_range, name) => {
        names.push(name);
      },
    });

    expect(names.sort()).toEqual(['Component', 'Original']);
  });

  it('should resolve identifier aliases at each call site', () => {
    const code = `
      function Component() {}
      const Alias = Component;
      var Name = function First() {};
      test(Alias, () => {});
      test(Name, () => {});
      var Name = function Second() {};
      test(Name, () => {});
    `;

    const names: string[] = [];
    parseTestFile(code, {
      onTest: (_range, name) => {
        names.push(name);
      },
    });

    expect(names).toEqual(['Component', 'First', 'Second']);
  });

  it('should not collect tests inside a function-valued title', () => {
    const code = `
      test(function Title() {
        test('phantom', () => {});
      }, () => {});
    `;

    const names: string[] = [];
    parseTestFile(code, {
      onTest: (_range, name) => {
        names.push(name);
      },
    });

    expect(names).toEqual(['Title']);
  });

  it('should handle complex template literals with multiple expressions', () => {
    const code = `
      const a = 1, b = 2;
      test(\`prefix \${a} middle \${b} suffix\`, () => {});
    `;

    const tests: { name: string; type: string }[] = [];
    parseTestFile(code, {
      onTest: (
        _range: Range,
        name: string,
        _testType: 'test' | 'it' | 'describe' | 'suite',
      ) => {
        tests.push({ name, type: 'test' });
      },
    });

    expect(tests.map((t) => t.name)).toEqual([
      'prefix ${...} middle ${...} suffix',
    ]);
  });

  it('should parse files with TSX/JSX content in callbacks', () => {
    const code = `
      describe('jsx', () => {
        it('renders', () => {
          const el = <div>Hello</div>;
        });
      });
    `;

    const tests: { name: string; type: string }[] = [];
    parseTestFile(code, {
      onTest: (
        _range: Range,
        name: string,
        testType: 'test' | 'it' | 'describe' | 'suite',
      ) => {
        tests.push({ name, type: testType });
      },
    });

    tests.sort((a, b) => a.name.localeCompare(b.name));

    expect(tests.map((t) => t.name)).toEqual(['jsx', 'renders']);
    expect(tests.map((t) => t.type)).toEqual(['describe', 'it']);
  });

  it('should ignore non-test-like calls', () => {
    const code = `
      foo('bar', () => {});
      something.test('not recognized', () => {});
      console.log('not a test');
    `;

    const tests: { name: string; type: string }[] = [];
    parseTestFile(code, {
      onTest: (
        _range: Range,
        name: string,
        testType: 'test' | 'it' | 'describe' | 'suite',
      ) => {
        tests.push({ name, type: testType });
      },
    });

    expect(tests.length).toBe(0);
  });

  it('should compute reasonable ranges for calls', () => {
    const code = `describe("top", () => {\n  it('child', () => {})\n});`;

    const results: { name: string; type: string; range: Range }[] = [];
    parseTestFile(code, {
      onTest: (range: Range, name: string, testType) => {
        results.push({ name, type: testType, range });
      },
    });

    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName.top.range.startLine).toBe(0);
    expect(byName.child.range.startLine).toBe(1);
  });

  it('should compute ranges correctly after leading comments', () => {
    const code = `/* eslint-disable max-lines */
/* eslint-disable max-lines-per-function */
describe('outer', () => {
  it('inner', () => {});
  it('inner-1', () => {});
});`;

    const results: { name: string; range: Range }[] = [];
    parseTestFile(code, {
      onTest: (range: Range, name: string) => {
        results.push({ name, range });
      },
    });

    expect(
      Object.fromEntries(
        results.map(({ name, range }) => [
          name,
          {
            start: { line: range.startLine, character: range.startChar },
            end: { line: range.endLine, character: range.endChar },
          },
        ]),
      ),
    ).toEqual({
      outer: {
        start: { line: 2, character: 0 },
        end: { line: 5, character: 2 },
      },
      inner: {
        start: { line: 3, character: 2 },
        end: { line: 3, character: 23 },
      },
      'inner-1': {
        start: { line: 4, character: 2 },
        end: { line: 4, character: 25 },
      },
    });
  });

  it('should compute range correctly with chinese characters', () => {
    const code = fs.readFileSync(
      join(__dirname, './parse.fixture.txt'),
      'utf-8',
    );

    const results: { name: string; type: string; range: Range }[] = [];
    parseTestFile(code, {
      onTest: (range: Range, name: string, testType) => {
        results.push({ name, type: testType, range });
      },
    });

    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName.outer.range.startLine).toBe(5);
    expect(byName.outer.range.endLine).toBe(8);
    expect(byName.inner.range.startLine).toBe(6);
  });

  it('should compute UTF-16 columns after astral characters', () => {
    const code = `const emoji = '😀'; test('unicode', () => {});`;

    const results: { name: string; range: Range }[] = [];
    parseTestFile(code, {
      onTest: (range: Range, name: string) => {
        results.push({ name, range });
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('unicode');
    expect(results[0].range.startChar).toBe(code.indexOf('test'));
  });

  it('should handle quotes and escaped characters', () => {
    const code = `
      describe('he said "hi"', () => {
        it('emoji 🚀', () => {});
      });
    `;

    const tests: { name: string; type: string }[] = [];
    parseTestFile(code, {
      onTest: (_range: Range, name: string, testType) => {
        tests.push({ name, type: testType });
      },
    });

    tests.sort((a, b) => a.name.localeCompare(b.name));
    expect(tests.map((t) => t.name)).toEqual(['emoji 🚀', 'he said "hi"']);
  });

  it('should handle comments and whitespace around arguments', () => {
    const code = `
      test /* c1 */ ( /* c2 */ 'spaced' /* c3 */ , () => {} );
      it/*a*/(/*b*/"also spaced"/*c*/,() => {});
    `;

    const tests: { name: string; type: string }[] = [];
    parseTestFile(code, {
      onTest: (_range: Range, name: string, testType) => {
        tests.push({ name, type: testType });
      },
    });

    tests.sort((a, b) => a.name.localeCompare(b.name));
    expect(tests.map((t) => t.name)).toEqual(['also spaced', 'spaced']);
  });

  it('should detect describe without a callback', () => {
    const code = `
      describe('name only');
    `;

    const tests: { name: string; type: string }[] = [];
    parseTestFile(code, {
      onTest: (_range: Range, name: string, testType) => {
        tests.push({ name, type: testType });
      },
    });

    expect(tests).toEqual([{ name: 'name only', type: 'describe' }]);
  });

  it('should find tests inside control flow blocks', () => {
    const code = `
      if (true) {
        describe('cond', () => {
          for (const _ of [1]) {
            test('inside loop', () => {});
          }
        });
      }
    `;

    const tests: { name: string; type: string }[] = [];
    parseTestFile(code, {
      onTest: (_range: Range, name: string, testType) => {
        tests.push({ name, type: testType });
      },
    });

    tests.sort((a, b) => a.name.localeCompare(b.name));
    expect(tests.map((t) => t.name)).toEqual(['cond', 'inside loop']);
    expect(tests.map((t) => t.type)).toEqual(['describe', 'test']);
  });

  it('should detect suite.skip variant', () => {
    const code = `
      suite.skip('skipped suite', () => {});
    `;

    const tests: { name: string; type: string }[] = [];
    parseTestFile(code, {
      onTest: (_range: Range, name: string, testType) => {
        tests.push({ name, type: testType });
      },
    });

    expect(tests).toEqual([{ name: 'skipped suite', type: 'suite' }]);
  });

  it('should reject invalid syntax', () => {
    expect(() =>
      parseTestFile('test(', {
        onTest: () => undefined,
      }),
    ).toThrow(SyntaxError);
  });

  it('should infer default import and namespace member titles', () => {
    const names: string[] = [];
    parseTestFile(
      `import Foo from './foo';
       import * as mod from './foo';
       describe(Foo, () => {});
       test(mod.Bar, () => {});
       test(mod, () => {});`,
      {
        onTest: (_range, name) => {
          names.push(name);
        },
      },
    );
    expect(names).toEqual(['Foo', 'Bar', 'unnamed test']);
  });

  it('should match runtime function titles across declarations and assignments', () => {
    const cases: Record<string, string> = {
      'function declaration': `function Foo() {} describe(Foo, () => {});`,
      'hoisted function': `describe(Foo, () => {}); function Foo() {}`,
      'class declaration': `class Foo {} describe(Foo, () => {});`,
      'const arrow': `const foo = () => {}; describe(foo, () => {});`,
      'named expression': `const a = function b() {}; describe(a, () => {});`,
      'alias chain': `function Foo() {} const A = Foo; const B = A; describe(B, () => {});`,
      'inline arrow': `describe(() => {}, () => {});`,
      'inline named function': `describe(function Foo() {}, () => {});`,
      'inline anonymous class': `describe(class {}, () => {});`,
      'let assigned later': `let foo; foo = () => {}; describe(foo, () => {});`,
      'var reassigned': `var Foo = function A() {}; test(Foo, () => {}); Foo = function B() {}; describe(Foo, () => {});`,
      'block shadow': `function Foo() {} { const Foo = function Bar() {}; describe(Foo, () => {}); } describe(Foo, () => {});`,
      'object method': `const o = { m() {} }; describe(o.m, () => {});`,
      'nested title': `class Foo {} describe(Foo, () => { test(Foo, () => {}); });`,
      'class static block': `class Foo { static { describe(Foo, () => {}); } }`,
      'deferred class reference': `const go = () => describe(Foo, () => {}); class Foo {} go();`,
      'inferred expression names': `let Foo; Foo = function() {}; test(Foo, () => {}); Foo = class {}; test(Foo, () => {});`,
      'alias before reassignment': `let Foo = function A() {}; const Alias = Foo; Foo = function B() {}; test(Alias, () => {}); test(Foo, () => {});`,
      'var in block': `{ var Foo = function Bar() {}; } test(Foo, () => {});`,
      'assignment scope': `let Foo = function Outer() {}; { let Foo = function Inner() {}; Foo = function Changed() {}; test(Foo, () => {}); } test(Foo, () => {}); { Foo = function Updated() {}; } test(Foo, () => {});`,
      'deferred callback assignment': `let Title = function Before() {}; test('mutator', () => { Title = function After() {}; }); test(Title, () => {});`,
      'bare var redeclaration': `var Title = function Real() {}; test(Title, () => {}); var Title; test(Title, () => {});`,
      'function expression self binding': `let Inner; const setup = function Inner() { test(Inner, () => {}); }; setup();`,
      'class expression self binding': `let Named; const C = class Named { static { test(Named, () => {}); } };`,
      'function local assignment': `function setup() { let Title = function Before() {}; { Title = function After() {}; } test(Title, () => {}); } setup();`,
    };

    for (const [label, code] of Object.entries(cases)) {
      const runtime: string[] = [];
      const register = (title: string | { name: string }) => {
        runtime.push(
          typeof title === 'string' ? title : title.name || '<anonymous>',
        );
      };
      new Function('describe', 'test', code)(
        (title: string | { name: string }, body: () => void) => {
          register(title);
          body();
        },
        register,
      );

      const names: string[] = [];
      parseTestFile(code, {
        onTest: (_range, name) => {
          names.push(name);
        },
      });
      expect(runtime.length).toBeGreaterThan(0);
      expect({ label, names }).toEqual({ label, names: runtime });
    }
  });

  it('should keep unknown bindings from falling back to outer names', () => {
    const names: string[] = [];
    parseTestFile(
      `function Foo() {}
       { let Foo; test(Foo, () => {}); }
       { const { value: Foo } = source; test(Foo, () => {}); }
       const run = (Foo) => test(Foo, () => {});
       try {} catch (Foo) { test(Foo, () => {}); }
       test(Foo, () => {});`,
      {
        onTest: (_range, name) => {
          names.push(name);
        },
      },
    );
    expect(names).toEqual([
      'unnamed test',
      'unnamed test',
      'unnamed test',
      'unnamed test',
      'Foo',
    ]);
  });
});
