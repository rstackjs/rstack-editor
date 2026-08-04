import assert from 'node:assert/strict';
import path from 'node:path';
import * as vscode from 'vscode';
import { detectFolder } from '../../../src/detection';
import type { StackId } from '../../../src/types';
import { eventually } from './helpers';

/**
 * Detection is per workspace folder, driven by the config-glob
 * table plus the `node_modules/.bin/{rs,rstack}` probe. The three fixtures are
 * chosen so that every column of that table is exercised at least once:
 *
 * | fixture | config present        | rslint | rstest | fmt |
 * | ------- | --------------------- | ------ | ------ | --- |
 * | rslint  | `rslint.config.mjs`   | yes    | no     | no  |
 * | rstest  | `rstest.config.ts`    | no     | yes    | no  |
 * | rstack  | `rstack.config.ts`    | no     | yes    | yes |
 *
 * The rstack row is the interesting one: a single `rstack.config.*` lights
 * Rstest and rs fmt even though no tool-native config exists (Rslint is
 * deliberately NOT lit — TODO(rstack-bridge), the earlier lint bridge was
 * removed pending upstream support), and `rs fmt`
 * is additionally confirmed by the bin probe (`rstack`'s two bins are `rs` and
 * `rstack`).
 *
 * This runs the extension's own `detectFolder` inside the extension host,
 * against the real fixture workspaces, through the real `workspace.findFiles`
 * and `workspace.fs` — the parts a unit test has to fake.
 */

interface Expectation {
  readonly detected: Readonly<Record<StackId, boolean>>;
  /** Tool-native config file names expected per stack. */
  readonly configFiles: Readonly<Record<StackId, readonly string[]>>;
  readonly rstackConfigFiles: readonly string[];
  /** Basename of the expected `rs fmt` bin, if the probe must find one. */
  readonly fmtBin?: string;
}

const EXPECTED: Readonly<Record<string, Expectation>> = {
  rslint: {
    detected: { rslint: true, rstest: false, fmt: false },
    configFiles: { rslint: ['rslint.config.mjs'], rstest: [], fmt: [] },
    rstackConfigFiles: [],
  },
  rstest: {
    detected: { rslint: false, rstest: true, fmt: false },
    configFiles: { rslint: [], rstest: ['rstest.config.ts'], fmt: [] },
    rstackConfigFiles: [],
  },
  rstack: {
    detected: { rslint: false, rstest: true, fmt: true },
    configFiles: { rslint: [], rstest: [], fmt: [] },
    rstackConfigFiles: ['rstack.config.ts'],
    fmtBin: 'rs',
  },
};

const basenames = (uris: readonly vscode.Uri[]): string[] =>
  uris.map((uri) => path.basename(uri.fsPath)).sort();

const folderNamed = (name: string): vscode.WorkspaceFolder => {
  const folder = (vscode.workspace.workspaceFolders ?? []).find(
    (candidate) => candidate.name === name,
  );
  assert.ok(folder, `the ${name} fixture folder is not in the workspace`);
  return folder;
};

suite('detection', () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    test(`lights the right stacks in the ${name} fixture`, async () => {
      const folder = folderNamed(name);

      // `findFiles` answers from the file index, which is still warming up when
      // the window has just opened, so the whole assertion block is retried.
      await eventually(async () => {
        const detection = await detectFolder(folder);

        const detected = {
          rslint: detection.stacks.rslint.detected,
          rstest: detection.stacks.rstest.detected,
          fmt: detection.stacks.fmt.detected,
        };
        assert.deepEqual(detected, expected.detected);

        for (const stack of ['rslint', 'rstest', 'fmt'] as const) {
          assert.deepEqual(
            basenames(detection.stacks[stack].configFiles),
            [...expected.configFiles[stack]].sort(),
            `${name}: unexpected ${stack} config files`,
          );
          assert.deepEqual(
            basenames(detection.stacks[stack].rstackConfigFiles),
            [...expected.rstackConfigFiles].sort(),
            `${name}: unexpected ${stack} rstack config files`,
          );
        }

        const binPath = detection.stacks.fmt.binPath;
        if (expected.fmtBin) {
          assert.ok(binPath, `${name}: the rs fmt bin probe found nothing`);
          assert.equal(path.basename(binPath), expected.fmtBin);
          assert.ok(
            binPath.includes(
              `${path.sep}node_modules${path.sep}.bin${path.sep}`,
            ),
            `${name}: the bin must come from node_modules/.bin, got ${binPath}`,
          );
        } else {
          assert.equal(
            binPath,
            undefined,
            `${name}: the rs fmt bin probe must find nothing`,
          );
        }
      }, `detection of the ${name} fixture`);
    });
  }

  test('never treats a fixture node_modules as a config source', async () => {
    // `**/node_modules/**` is excluded on purpose: a nested config inside a
    // dependency would light a stack no tool would ever load there.
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(
        folderNamed('rstack'),
        '**/rstack.config.{ts,js,mts,mjs}',
      ),
      '**/node_modules/**',
    );
    assert.deepEqual(basenames(found), ['rstack.config.ts']);
  });
});
