import { describe, expect, it } from '@rstest/core';
import { routeToOwners } from '../../../src/stacks/test/runRouting';

type Item = {
  kind: 'file' | 'case' | 'project' | 'folder';
  uri: string;
  ownsFile: boolean;
};
const resolve = (item: Item) =>
  item.kind === 'file' || item.kind === 'case'
    ? { uri: { toString: () => item.uri }, ownsFile: item.ownsFile }
    : undefined;
const rootFile: Item = {
  kind: 'file',
  uri: 'file:///repo/host/a.test.ts',
  ownsFile: false,
};
const hostFile: Item = { ...rootFile, ownsFile: true };
const rootCase: Item = { ...rootFile, kind: 'case' };
const hostCase: Item = { ...hostFile, kind: 'case' };

describe('routeToOwners', () => {
  it('keeps only the owner when two projects select the same file URI', () => {
    expect(routeToOwners([rootFile, hostFile], resolve)).toEqual([hostFile]);
  });

  it('keeps an explicit non-owner file or case selection', () => {
    expect(routeToOwners([rootFile, rootCase], resolve)).toEqual([
      rootFile,
      rootCase,
    ]);
  });

  it('preserves unrelated items and order while routing mixed file and case items', () => {
    const project: Item = { ...rootFile, kind: 'project' };
    const folder: Item = { ...hostFile, kind: 'folder' };
    const unrelated: Item = { ...rootFile, uri: 'file:///repo/other.test.ts' };
    const items = [
      project,
      rootCase,
      unrelated,
      hostFile,
      folder,
      rootFile,
      hostCase,
    ];
    expect(routeToOwners(items, resolve)).toEqual([
      project,
      unrelated,
      hostFile,
      folder,
      hostCase,
    ]);
    expect(items).toHaveLength(7);
  });

  it('keeps tied owners and an empty selection', () => {
    const tied = { ...hostFile };
    expect(routeToOwners([hostFile, tied], resolve)).toEqual([hostFile, tied]);
    expect(routeToOwners([], resolve)).toEqual([]);
  });
});
