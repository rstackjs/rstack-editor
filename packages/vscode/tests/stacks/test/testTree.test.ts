import { describe, expect, it, rs } from '@rstest/core';

rs.mock('vscode', () => {
  class Range {
    constructor(
      public startLine: number,
      public startChar: number,
      public endLine: number,
      public endChar: number,
    ) {}
  }
  const channel = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    appendLine: () => {},
    dispose: () => {},
  };
  const vscode = {
    Range,
    Uri: {
      file: (fsPath: string) => ({
        fsPath,
        toString: () => `file://${fsPath}`,
      }),
    },
    window: { createOutputChannel: () => channel },
    workspace: { fs: {} },
  };
  return { ...vscode, default: vscode };
});

const makeCollection = () => {
  const map = new Map<string, any>();
  return {
    replace: (items: any[]) => {
      map.clear();
      for (const item of items) map.set(item.id, item);
    },
    forEach: (cb: (item: any) => void) => map.forEach((v) => cb(v)),
    get: (id: string) => map.get(id),
    get size() {
      return map.size;
    },
  };
};

const createController = () =>
  ({
    createTestItem: (id: string, label: string, uri: unknown) => ({
      id,
      label,
      uri,
      range: undefined as any,
      error: undefined as any,
      children: makeCollection(),
    }),
  }) as any;

const location = (line: number) => ({ line, column: 3 });

// suite "outer" @ line 7, cases "a" @ 12 and "b" @ 16 (1-based, like core)
const withLocations = [
  {
    testId: 'outer',
    type: 'suite',
    name: 'outer',
    location: location(7),
    tests: [
      { type: 'case', name: 'a', location: location(12), tests: [] },
      { type: 'case', name: 'b', location: location(16), tests: [] },
    ],
  },
] as any;

const withoutLocations = [
  {
    testId: 'outer',
    type: 'suite',
    name: 'outer',
    location: undefined,
    tests: [
      { type: 'case', name: 'a', location: undefined, tests: [] },
      { type: 'case', name: 'b', location: undefined, tests: [] },
    ],
  },
] as any;

describe('TestFile.updateFromList', () => {
  it('keeps existing ranges when a rebuilt test reports no location', async () => {
    const { TestFile } = await import('../../../src/stacks/test/testTree');
    const controller = createController();
    const uri = { fsPath: '/x/outer.test.ts', toString: () => 'file:///x' };
    const file = new TestFile({} as any, uri as any, controller);
    const root = controller.createTestItem('root', 'outer.test.ts', uri);
    file.setTestItem(root);

    // Discovery-like pass with real source locations.
    file.updateFromList(withLocations);
    const suite1 = root.children.get('outer');
    expect(suite1.range.startLine).toBe(6);
    expect(suite1.children.get('a').range.startLine).toBe(11);
    expect(suite1.children.get('b').range.startLine).toBe(15);

    // A run reports the same tests without locations; ranges must survive
    // instead of collapsing to line 1.
    file.updateFromList(withoutLocations);
    const suite2 = root.children.get('outer');
    expect(suite2.range.startLine).toBe(6);
    expect(suite2.children.get('a').range.startLine).toBe(11);
    expect(suite2.children.get('b').range.startLine).toBe(15);
  });

  it('uses the reported location when one is present', async () => {
    const { TestFile } = await import('../../../src/stacks/test/testTree');
    const controller = createController();
    const uri = { fsPath: '/x/outer.test.ts', toString: () => 'file:///x' };
    const file = new TestFile({} as any, uri as any, controller);
    file.setTestItem(controller.createTestItem('root', 'outer.test.ts', uri));

    file.updateFromList(withLocations);
    file.updateFromList([
      {
        testId: 'outer',
        type: 'suite',
        name: 'outer',
        location: location(9),
        tests: [{ type: 'case', name: 'a', location: location(20), tests: [] }],
      },
    ] as any);

    const root = (file as any).testItem;
    const suite = root.children.get('outer');
    expect(suite.range.startLine).toBe(8);
    expect(suite.children.get('a').range.startLine).toBe(19);
  });

  it('preserves separate ranges for duplicate sibling names', async () => {
    const { TestFile, getTestItemId } =
      await import('../../../src/stacks/test/testTree');
    const controller = createController();
    const uri = { fsPath: '/x/dup.test.ts', toString: () => 'file:///x' };
    const file = new TestFile({} as any, uri as any, controller);
    const root = controller.createTestItem('root', 'dup.test.ts', uri);
    file.setTestItem(root);

    const dup = [
      {
        testId: 'renders-1',
        type: 'case',
        name: 'renders',
        location: location(4),
        tests: [],
      },
      {
        testId: 'renders-2',
        type: 'case',
        name: 'renders',
        location: location(9),
        tests: [],
      },
    ] as any;
    file.updateFromList(dup);
    // duplicate siblings get distinct ids by occurrence index
    expect(root.children.get(getTestItemId('renders', 0)).range.startLine).toBe(
      3,
    );
    expect(root.children.get(getTestItemId('renders', 1)).range.startLine).toBe(
      8,
    );

    // location-less rebuild must keep each occurrence's own range, not collapse
    // both onto the last one's.
    file.updateFromList([
      {
        testId: 'renders-1',
        type: 'case',
        name: 'renders',
        location: undefined,
        tests: [],
      },
      {
        testId: 'renders-2',
        type: 'case',
        name: 'renders',
        location: undefined,
        tests: [],
      },
    ] as any);
    expect(root.children.get(getTestItemId('renders', 0)).range.startLine).toBe(
      3,
    );
    expect(root.children.get(getTestItemId('renders', 1)).range.startLine).toBe(
      8,
    );
  });

  it('builds a hierarchy from flat listed tests', async () => {
    const { TestFile } = await import('../../../src/stacks/test/testTree');
    const controller = createController();
    const uri = { fsPath: '/x/flat.test.ts', toString: () => 'file:///x' };
    const file = new TestFile({} as any, uri as any, controller);
    const root = controller.createTestItem('root', 'flat.test.ts', uri);
    file.setTestItem(root);
    file.updateFromListedTests([
      {
        testPath: uri.fsPath,
        name: 'outer',
        fullName: 'outer',
        parentNames: [],
        project: 'rstest',
        type: 'suite',
      },
      {
        testPath: uri.fsPath,
        name: 'case',
        fullName: 'outer > case',
        parentNames: ['outer'],
        project: 'rstest',
        type: 'case',
      },
    ] as any);
    expect(root.children.get('outer').children.get('case').label).toBe('case');
  });

  it('keeps empty-named cases under an empty-named listed suite', async () => {
    const { TestFile } = await import('../../../src/stacks/test/testTree');
    const controller = createController();
    const uri = {
      fsPath: '/x/empty-names.test.ts',
      toString: () => 'file:///x',
    };
    const file = new TestFile({} as any, uri as any, controller);
    const root = controller.createTestItem('root', 'empty-names.test.ts', uri);
    file.setTestItem(root);
    file.updateFromListedTests([
      {
        testPath: uri.fsPath,
        name: '',
        fullName: '',
        parentNames: [],
        project: 'rstest',
        type: 'suite',
      },
      {
        testPath: uri.fsPath,
        name: '',
        fullName: ' > ',
        parentNames: [''],
        project: 'rstest',
        type: 'case',
      },
      {
        testPath: uri.fsPath,
        name: 'normal',
        fullName: ' > normal',
        parentNames: [''],
        project: 'rstest',
        type: 'case',
      },
    ]);
    const suite = root.children.get('');
    expect(suite).toBeDefined();
    expect(root.children.size).toBe(1);
    expect(suite.children.size).toBe(2);
    expect(suite.children.get('').label).toBe('');
    expect(suite.children.get('normal').label).toBe('normal');
  });

  it('groups files and seeds empty filtered refreshes', async () => {
    const { TestFile, groupListedTestsByFile } =
      await import('../../../src/stacks/test/testTree');
    const testPath = '/x/empty.test.ts';
    expect(
      groupListedTestsByFile([
        { project: 'rstest', testPath, type: 'file' },
      ] as any)[0]?.tests,
    ).toEqual([]);
    const removed = '/x/removed.test.ts';
    const [group] = groupListedTestsByFile([], [removed]);
    expect(group.uri.fsPath).toBe(removed);
    const controller = createController();
    const file = new TestFile({} as any, group.uri, controller);
    const root = controller.createTestItem(
      'root',
      'removed.test.ts',
      group.uri,
    );
    file.setTestItem(root);
    file.updateFromList(withLocations);
    expect(root.children.size).toBe(1);
    file.updateFromListedTests(group.tests);
    expect(root.children.size).toBe(0);
  });

  it('renders skipped and todo tests from a structured list', async () => {
    const { TestFile } = await import('../../../src/stacks/test/testTree');
    const controller = createController();
    const uri = { fsPath: '/x/modes.test.ts', toString: () => 'file:///x' };
    const file = new TestFile({} as any, uri as any, controller);
    const root = controller.createTestItem('root', 'modes.test.ts', uri);
    file.setTestItem(root);
    file.updateFromListedTests(
      ['skip', 'todo'].map((runMode) => ({
        testPath: uri.fsPath,
        name: runMode,
        fullName: runMode,
        parentNames: [],
        project: 'rstest',
        type: 'case',
        runMode,
      })) as any,
    );
    expect(root.children.get('skip').description).toBe('skip');
    expect(root.children.get('todo').description).toBe('todo');
  });

  it('renders only the first project hierarchy for a shared file', async () => {
    const { TestFile, groupListedTestsByFile } =
      await import('../../../src/stacks/test/testTree');
    const controller = createController();
    const uri = { fsPath: '/x/shared.test.ts', toString: () => 'file:///x' };
    const file = new TestFile({} as any, uri as any, controller);
    const root = controller.createTestItem('root', 'shared.test.ts', uri);
    file.setTestItem(root);
    const [group] = groupListedTestsByFile([
      {
        testPath: uri.fsPath,
        name: 'suite',
        fullName: 'suite',
        parentNames: [],
        project: 'alpha',
        type: 'suite',
      },
      {
        testPath: uri.fsPath,
        name: 'alpha',
        fullName: 'suite > alpha',
        parentNames: ['suite'],
        project: 'alpha',
        type: 'case',
      },
      {
        testPath: uri.fsPath,
        name: 'suite',
        fullName: 'suite',
        parentNames: [],
        project: 'beta',
        type: 'suite',
      },
      {
        testPath: uri.fsPath,
        name: 'beta',
        fullName: 'suite > beta',
        parentNames: ['suite'],
        project: 'beta',
        type: 'case',
      },
    ] as any);
    file.updateFromListedTests(group.tests);
    expect(root.children.get('suite').children.get('alpha').label).toBe(
      'alpha',
    );
    expect(root.children.get('suite').children.get('beta')).toBeUndefined();
  });
});
