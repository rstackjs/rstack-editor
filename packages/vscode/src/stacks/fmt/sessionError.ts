import path from 'node:path';
import type { MessageType as LspMessageType } from 'vscode-languageclient/node';
import { classifyMissingDependencyMessage } from '../../shared/missingDependency';
import type { ConfigDependencyEpisode } from '../../shared/notInstalled';

export const FMT_SESSION_ERROR_PREFIX = 'rs fmt cannot format this workspace: ';

// Importing the runtime value from vscode-languageclient also evaluates its
// `vscode` dependency, which would make this otherwise pure module unusable in
// Node unit tests. These are the LSP MessageType values it re-exports.
const MessageType = {
  Error: 1 as LspMessageType,
  Warning: 2 as LspMessageType,
  Info: 3 as LspMessageType,
};

export interface FmtConfigDependencyFailure {
  readonly configPath: string;
  readonly cause: string;
}

export interface ShowMessageParams {
  readonly type: LspMessageType;
  readonly message: string;
}

export interface ShowMessagePresenter {
  showErrorMessage(message: string): void;
  showWarningMessage(message: string): void;
  showInformationMessage(message: string): void;
}

export interface FmtShowMessageHandler extends ShowMessagePresenter {
  onConfigDependency(failure: FmtConfigDependencyFailure): void;
}

export function classifyFmtSessionError(
  message: ShowMessageParams,
  workspaceRoot: string,
  configPath: string,
): FmtConfigDependencyFailure | undefined {
  if (
    message.type !== MessageType.Error ||
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
  type: LspMessageType,
): 'error' | 'warning' | 'information' => {
  switch (type) {
    case MessageType.Error:
      return 'error';
    case MessageType.Warning:
      return 'warning';
    default:
      return 'information';
  }
};

/** Reproduces vscode-languageclient's default show-message UI routing. */
export const presentShowMessage = (
  message: ShowMessageParams,
  presenter: ShowMessagePresenter,
): void => {
  switch (showMessagePresentation(message.type)) {
    case 'error':
      presenter.showErrorMessage(message.message);
      break;
    case 'warning':
      presenter.showWarningMessage(message.message);
      break;
    case 'information':
      presenter.showInformationMessage(message.message);
      break;
  }
};

/** Filters the one stack-owned state transition and passes every other server UI request through. */
export const handleFmtShowMessage = (
  message: ShowMessageParams,
  workspaceRoot: string,
  configPath: string | undefined,
  handler: FmtShowMessageHandler,
): void => {
  const failure =
    configPath === undefined
      ? undefined
      : classifyFmtSessionError(message, workspaceRoot, configPath);
  if (failure !== undefined) {
    handler.onConfigDependency(failure);
    return;
  }
  presentShowMessage(message, handler);
};

/**
 * Ends the warning episode only when this formatting request completed
 * without another classified show-message notification. A failed config load
 * also resolves with empty edits, so the response alone is not success.
 */
export const finishSuccessfulFormatting = (
  episode: ConfigDependencyEpisode,
  suppressedBeforeRequest: number,
  suppressedAfterRequest: number,
): boolean =>
  suppressedBeforeRequest === suppressedAfterRequest && episode.clear();
