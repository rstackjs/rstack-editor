import { describe, expect, it } from '@rstest/core';
import { routeToOwners } from '../../../src/stacks/test/runRouting';

type Item = {
  kind: 'file' | 'case' | 'project' | 'folder';
  uri: string;
  root: string;
};
const resolve = (item: Item) =>
  item.kind === 'file' || item.kind === 'case'
    ? { uri: item.uri, root: item.root }
    : undefined;
const rootFile: Item = {
  kind: 'file',
  uri: 'file:///repo/host/a.test.ts',
  root: '/repo',
};
const hostFile: Item = { ...rootFile, root: '/repo/host' };
const rootCase: Item = { ...rootFile, kind: 'case' };
const hostCase: Item = { ...hostFile, kind: 'case' };

describe('routeToOwners', () => {
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
