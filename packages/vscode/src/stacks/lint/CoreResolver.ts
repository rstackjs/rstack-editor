// Ported from web-infra-dev/rslint `packages/vscode-extension/src/CoreResolver.ts`
// (rslint #1617, commit 39536fd6) and adapted to this extension.
//
// Upstream's resolver *loads* the selected `@rslint/core`: it requires
// `config-loader` / `eslint-plugin` from the package directory, calls
// `resolveRslintBinary()` and keeps the module factories on the installation.
// Here the extension host must never load project code (adaptation 3,
// `docs/adr/0003-lint-through-editor-worker.md`): the host walks the chain as
// far as the **core directory** with `fs.stat` + `package.json` reads, and the
// Lint worker takes the last hop (`--core <dir>`) on the User Node runtime.
//
// What is kept verbatim in spirit:
// - identity is the **real path** of the `@rslint/core` package directory, so
//   two same-version copies stay separate cores and a symlink to one copy is
//   that copy (CONTEXT.md, "Rslint core");
// - the runtime key is `workspaceFolder + core identity`, so one folder runs
//   one Lint runtime per physical core;
// - resolution is per document.
//
// Not kept: upstream's installation cache. It memoizes the module loading this
// host no longer does; the chain walk left is `fs.statSync` + one
// `package.json` read per hop and must see the current `node_modules`, so
// nothing is cached and `clear()` is a no-op kept for the `RuntimeManager`
// contract.

import path from 'node:path';
import type { TextDocument, WorkspaceFolder } from 'vscode';
import {
  checkPackageVersion,
  formatVersionMismatch,
} from '../../shared/versionCheck';
import {
  resolveRslint,
  type RslintMode,
  type RslintResolution,
} from './resolution';
import { RslintVersionMismatchError } from './status';

/**
 * One **Rslint core** the extension is willing to run, plus the folder-level
 * config choice the Lint worker needs on its command line.
 *
 * `shimPath` is part of the runtime's identity, not decoration: the supported
 * config protocols lock `configPath` for the server's lifetime (ADR 0003), so
 * a folder that flips native ↔ bridged must get a *new* runtime even when both
 * modes resolve the same physical core. Upstream has no bridged mode and keys
 * on the core alone.
 */
export interface CoreInstallation {
  /** Stable physical identity. Never merge cores by version text alone. */
  readonly identity: string;
  readonly packageDirectory: string;
  readonly version: string | undefined;
  readonly mode: RslintMode;
  readonly shimPath?: string;
  readonly rstackDirectory?: string;
  readonly rstackVersion?: string;
}

export interface ResolvedCoreRuntime {
  readonly key: string;
  readonly workspaceFolder: WorkspaceFolder;
  readonly installation: CoreInstallation;
}

/** What the folder's detection decided, handed down per document. */
export interface CoreResolutionRequest {
  readonly mode: RslintMode;
  /** `rstack.rslint.corePath`, read with the document's URI (resource scope). */
  readonly corePath?: string;
}

function normalizeIdentity(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function runtimeKey(
  workspaceFolder: WorkspaceFolder,
  installation: CoreInstallation,
): string {
  return `${workspaceFolder.uri.toString()}\0${installation.identity}\0${
    installation.shimPath ?? ''
  }`;
}

/**
 * The version gate, applied **per resolved core** rather than per folder: two
 * runtimes in one folder can sit on different copies, and only the failing one
 * must be refused. A mismatch names the directory it came from, because with
 * several cores in play "0.7.3 is not supported" is not actionable alone.
 */
function validateInstallation(
  identity: string,
  resolution: RslintResolution,
): CoreInstallation {
  if (resolution.mode === 'bridged') {
    const rstackCheck = checkPackageVersion('rstack', resolution.rstackVersion);
    if (rstackCheck.kind === 'mismatch') {
      throw new RslintVersionMismatchError(
        `${formatVersionMismatch('rstack', rstackCheck)} (${resolution.rstackDir ?? 'unknown location'})`,
      );
    }
  }
  const coreCheck = checkPackageVersion('@rslint/core', resolution.coreVersion);
  if (coreCheck.kind === 'mismatch') {
    throw new RslintVersionMismatchError(
      `${formatVersionMismatch('@rslint/core', coreCheck)} (${resolution.coreDir})`,
    );
  }
  return {
    identity,
    packageDirectory: resolution.coreDir,
    version: resolution.coreVersion,
    mode: resolution.mode,
    ...(resolution.shimPath === undefined
      ? {}
      : {
          shimPath: resolution.shimPath,
          rstackDirectory: resolution.rstackDir,
          rstackVersion: resolution.rstackVersion,
        }),
  };
}

/**
 * Resolves the Rslint core each open document should be linted by, and gives
 * every physical core inside one workspace folder one stable runtime key.
 */
export class CoreResolver {
  /** Nothing is cached (see the header); the `RuntimeManager` port calls this. */
  public clear(): void {}

  public async resolve(
    document: Pick<TextDocument, 'uri'>,
    workspaceFolder: WorkspaceFolder,
    request: CoreResolutionRequest,
  ): Promise<ResolvedCoreRuntime> {
    const resolution = resolveRslint({
      folderRoot: workspaceFolder.uri.fsPath,
      mode: request.mode,
      corePath: request.corePath,
      documentDirectory: path.dirname(document.uri.fsPath),
    });
    const installation = validateInstallation(
      normalizeIdentity(resolution.coreDir),
      resolution,
    );
    return {
      key: runtimeKey(workspaceFolder, installation),
      workspaceFolder,
      installation,
    };
  }
}
