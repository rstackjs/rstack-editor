import path from 'node:path';
import { beforeEach, describe, expect, it, rs } from '@rstest/core';
import type vscode from 'vscode';

/**
 * Detection's lint row, end to end through `detectFolder` itself.
 *
 * `tests/stacks/lint/rstackBridge.test.ts` covers the Ownership rule as a pure
 * decision table; this file covers the *wiring* — that the shell feeds the rule
 * the right two file lists and reports its answer as `stacks.rslint.detected`.
 * `detectFolder` only exists against `workspace.findFiles`, so the namespace is
 * stubbed with a glob-keyed file table (the E2E `vscode` slice runs the same
 * function against real fixtures and a real file index).
 */

interface FileTable {
  [glob: string]: string[];
}

const state: { files: FileTable; bins: string[] } = { files: {}, bins: [] };

rs.mock('vscode', () => {
  const toUri = (fsPath: string) => ({
    fsPath,
    path: fsPath,
    scheme: 'file',
    toString: () => `file://${fsPath}`,
  });
  const vscodeStub = {
    Uri: {
      file: toUri,
      joinPath: (base: { fsPath: string }, ...segments: string[]) =>
        toUri(path.join(base.fsPath, ...segments)),
    },
    RelativePattern: class {
      constructor(
        readonly base: unknown,
        readonly pattern: string,
      ) {}
    },
    EventEmitter: class {
      readonly event = () => ({ dispose: () => undefined });
      fire(): void {}
      dispose(): void {}
    },
    workspace: {
      workspaceFolders: undefined,
      onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }),
      onDidChangeConfiguration: () => ({ dispose: () => undefined }),
      getConfiguration: () => ({ get: () => undefined }),
      findFiles: (pattern: { pattern: string }) =>
        Promise.resolve((state.files[pattern.pattern] ?? []).map(toUri)),
      fs: {
        stat: (uri: { fsPath: string }) =>
          state.bins.includes(uri.fsPath)
            ? Promise.resolve({})
            : Promise.reject(new Error('ENOENT')),
      },
    },
  };
  return { ...vscodeStub, default: vscodeStub };
});

import {
  detectFolder,
  RSLINT_CONFIG_GLOB,
  RSTACK_CONFIG_GLOB,
} from '../src/detection';

const FOLDER_PATH = path.resolve('/projects/app');
const folder = {
  uri: { fsPath: FOLDER_PATH, path: FOLDER_PATH, toString: () => 'file://app' },
  name: 'app',
  index: 0,
} as unknown as vscode.WorkspaceFolder;

const at = (...segments: string[]): string =>
  path.join(FOLDER_PATH, ...segments);

const withFiles = (files: { rslint?: string[]; rstack?: string[] }): void => {
  state.files = {
    [RSLINT_CONFIG_GLOB]: files.rslint ?? [],
    [RSTACK_CONFIG_GLOB]: files.rstack ?? [],
  };
};

describe('detection lights Rslint', () => {
  beforeEach(() => {
    state.files = {};
    state.bins = [];
  });

  it('for a native config anywhere', async () => {
    withFiles({ rslint: [at('packages', 'ui', 'rslint.config.mjs')] });
    const detection = await detectFolder(folder);
    expect(detection.stacks.rslint.detected).toBe(true);
  });

  it('for a bridged folder: root rstack.config.* and no native config', async () => {
    withFiles({ rstack: [at('rstack.config.ts')] });
    const detection = await detectFolder(folder);
    expect(detection.stacks.rslint.detected).toBe(true);
    // The lint row still reports *native* configs in `configFiles`; the Rstack
    // config reaches the stack through `rstackConfigFiles`.
    expect(detection.stacks.rslint.configFiles).toEqual([]);
    expect(
      detection.stacks.rslint.rstackConfigFiles.map((uri) => uri.fsPath),
    ).toEqual([at('rstack.config.ts')]);
  });

  it('not for a rstack.config.* that only sits in a subdirectory', async () => {
    withFiles({ rstack: [at('packages', 'ui', 'rstack.config.ts')] });
    const detection = await detectFolder(folder);
    expect(detection.stacks.rslint.detected).toBe(false);
    // The other two stacks are lit by a Rstack config anywhere — the
    // asymmetry is the language server's, and this is where it shows.
    expect(detection.stacks.rstest.detected).toBe(true);
    expect(detection.stacks.fmt.detected).toBe(true);
  });

  it('not for a folder with no config at all', async () => {
    withFiles({});
    const detection = await detectFolder(folder);
    expect(detection.stacks.rslint.detected).toBe(false);
  });
});
