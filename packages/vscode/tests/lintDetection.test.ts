import path from 'node:path';
import { describe, expect, it, rs } from '@rstest/core';
import vscode from 'vscode';
import { detectFolder, RSTACK_CONFIG_GLOB } from '../src/detection';

let configPaths: string[] = [];
rs.mock('vscode', () => {
  const file = (fsPath: string) => ({ fsPath, toString: () => fsPath });
  const api = {
    Uri: {
      file,
      joinPath: (uri: { fsPath: string }, ...parts: string[]) =>
        file(path.join(uri.fsPath, ...parts)),
    },
    RelativePattern: class {
      constructor(
        readonly folder: unknown,
        readonly pattern: string,
      ) {}
    },
    workspace: {
      getConfiguration: () => ({ get: () => undefined }),
      findFiles: async ({ pattern }: { pattern: string }) =>
        pattern === RSTACK_CONFIG_GLOB ? configPaths.map(file) : [],
      fs: {
        stat: async () => {
          throw new Error('not found');
        },
      },
    },
  };
  return { ...api, default: api };
});

describe('Rslint folder ownership', () => {
  it('selects the root config by loader precedence rather than discovery order', async () => {
    const folder = path.resolve('/workspace');
    const ts = path.join(folder, 'rstack.config.ts');
    const js = path.join(folder, 'rstack.config.js');
    const workspaceFolder = {
      uri: vscode.Uri.file(folder),
      name: 'workspace',
      index: 0,
    };
    for (const ordered of [
      [js, ts],
      [ts, js],
    ]) {
      configPaths = ordered;
      expect((await detectFolder(workspaceFolder)).rootRstackConfigPath).toBe(
        ts,
      );
    }
  });

  it('attributes bridge failures to the root config regardless of discovery order', async () => {
    const folder = path.resolve('/workspace');
    const root = path.join(folder, 'rstack.config.ts');
    const nested = path.join(folder, 'packages', 'app', 'rstack.config.ts');
    const workspaceFolder = {
      uri: vscode.Uri.file(folder),
      name: 'workspace',
      index: 0,
    };
    for (const ordered of [
      [nested, root],
      [root, nested],
    ]) {
      configPaths = ordered;
      const snapshot = await detectFolder(workspaceFolder);
      expect(snapshot.rootRstackConfigPath).toBe(root);
    }
    configPaths = [nested];
    expect(
      (await detectFolder(workspaceFolder)).rootRstackConfigPath,
    ).toBeUndefined();
  });
});
