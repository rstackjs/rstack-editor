import vscode from 'vscode';
import { NODE_EXECUTABLE_SETTING } from './nodeResolution';

/**
 * The `${workspaceFolder}` substitution the manifest promises for the runtime
 * pin and the test stack's exec-args. One definition: any change to the rule
 * (a second placeholder, trimming) must hold for every setting that documents
 * it.
 */
export const expandWorkspaceFolder = (
  value: string,
  folder: vscode.WorkspaceFolder,
): string => value.replaceAll('${workspaceFolder}', folder.uri.fsPath);

/**
 * The shared User Node runtime pin (`rstack.nodeExecutable`), read by every
 * stack that spawns a project-loading child process (the rstest worker, the
 * `rs fmt --lsp` server). One setting rather than one per stack on purpose:
 * the runtime selection logic is uniform across stacks, so the escape hatch
 * must be too — a user pinning Node for one tool means it for the toolchain.
 *
 * Returns the configured executable for a folder, `${workspaceFolder}`
 * expanded, or `undefined` when the setting is unset or blank (both mean "let
 * the extension pick one").
 */
export const getConfiguredNodeExecutable = (
  folder: vscode.WorkspaceFolder,
): string | undefined => {
  const value = vscode.workspace
    .getConfiguration(undefined, folder.uri)
    .get(NODE_EXECUTABLE_SETTING);
  if (typeof value !== 'string' || value === '') {
    return undefined;
  }
  return expandWorkspaceFolder(value, folder);
};
