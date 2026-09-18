import { describe, expect, it } from '@rstest/core';
import { routeToOwners } from '../../../src/stacks/test/runRouting';

type Item = {
  kind: 'file' | 'case' | 'project' | 'folder';
  uri: string;
  root: string;
  namePath?: string[];
};
const resolve = (item: Item) =>
  item.kind === 'file' || item.kind === 'case'
    ? {
        key:
          item.kind === 'case'
            ? `${item.uri}#${JSON.stringify(item.namePath)}`
            : item.uri,
        root: item.root,
      }
    : undefined;
const rootFile: Item = {
  kind: 'file',
  uri: 'file:///repo/host/a.test.ts',
  root: '/repo',
};
const hostFile: Item = { ...rootFile, root: '/repo/host' };
const rootCase: Item = { ...rootFile, kind: 'case', namePath: ['suite', 'A'] };
const hostCase: Item = { ...hostFile, kind: 'case', namePath: ['suite', 'A'] };

describe('routeToOwners', () => {
  it('keeps distinct cases from different projects but routes the same case to its owner', () => {
    const hostCaseB: Item = { ...hostCase, namePath: ['suite', 'B'] };
    expect(routeToOwners([rootCase, hostCaseB], resolve)).toEqual({
      kept: [rootCase, hostCaseB],
      dropped: [],
    });
    expect(routeToOwners([rootCase, hostCase], resolve)).toEqual({
      kept: [hostCase],
      dropped: [rootCase],
    });
  });

  it('keeps an explicit non-owner file or case selection', () => {
    expect(routeToOwners([rootFile, rootCase], resolve)).toEqual({
      kept: [rootFile, rootCase],
      dropped: [],
    });
  });

  it('preserves unrelated items and order while routing mixed file and case items', () => {
    const project: Item = { ...rootFile, kind: 'project' };
    const folder: Item = { ...hostFile, kind: 'folder' };
    const unrelated: Item = { ...rootFile, uri: 'file:///repo/other.test.ts' };
    const tied = { ...hostFile };
    const items = [
      project,
      rootCase,
      unrelated,
      hostFile,
      folder,
      rootFile,
      tied,
      hostCase,
    ];
    expect(routeToOwners(items, resolve)).toEqual({
      kept: [project, unrelated, hostFile, folder, tied, hostCase],
      dropped: [rootCase, rootFile],
    });
  });
});
