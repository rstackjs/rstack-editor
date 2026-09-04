import path from 'node:path';
import { classifyMissingDependencyMessage } from '../../shared/missingDependency';

export const FMT_SESSION_ERROR_PREFIX = 'rs fmt cannot format this workspace: ';

export interface FmtConfigDependencyFailure {
  readonly configPath: string;
  readonly cause: string;
}

interface ShowMessageParams {
  readonly type: number;
  readonly message: string;
}

export function classifyFmtSessionError(
  message: ShowMessageParams,
  workspaceRoot: string,
  configPath: string,
): FmtConfigDependencyFailure | undefined {
  if (
    message.type !== 1 ||
    !message.message.startsWith(FMT_SESSION_ERROR_PREFIX)
  ) {
    return undefined;
  }
  const cause = message.message
    .slice(FMT_SESSION_ERROR_PREFIX.length)
    .replace(/^Error(?: \[[A-Z_]+\])?: /, '');
  const firstLine = cause.split('\n', 1)[0];
  const classified = classifyMissingDependencyMessage(firstLine, workspaceRoot);
  if (classified === undefined) return undefined;
  const relative = path.relative(workspaceRoot, configPath);
  return {
    configPath: relative.length > 0 ? relative : path.basename(configPath),
    cause: classified,
  };
}

export const showMessagePresentation = (
  type: number,
): 'error' | 'warning' | 'information' => {
  switch (type) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    default:
      return 'information';
  }
};
