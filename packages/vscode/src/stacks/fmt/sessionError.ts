import path from 'node:path';
import type {
  MessageType as LspMessageType,
  ShowMessageParams,
} from 'vscode-languageclient';
import { classifyMissingDependencyMessage } from '../../shared/missingDependency';
import type {
  NotInstalledEpisode,
  ConfigDependencyFailure,
} from '../../shared/notInstalled';

export const FMT_SESSION_ERROR_PREFIX = 'rs fmt cannot format this workspace: ';

// Importing the runtime value from vscode-languageclient also evaluates its
// `vscode` dependency, which would make this otherwise pure module unusable in
// Node unit tests. These are the LSP MessageType values it re-exports.
const MessageType = {
  Error: 1 as LspMessageType,
  Warning: 2 as LspMessageType,
  Info: 3 as LspMessageType,
};

interface ShowMessagePresenter {
  showErrorMessage(message: string): void;
  showWarningMessage(message: string): void;
  showInformationMessage(message: string): void;
}

interface FmtShowMessageHandler extends ShowMessagePresenter {
  onConfigDependency(failure: ConfigDependencyFailure): void;
  onConfigError(message: string): void;
}

export function classifyFmtSessionError(
  message: ShowMessageParams,
  workspaceRoot: string,
  configPath: string,
): ConfigDependencyFailure | undefined {
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

/** Reports config failures as state, suppressing only missing-dependency UI requests. */
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
  switch (message.type) {
    case MessageType.Error:
      if (message.message.startsWith(FMT_SESSION_ERROR_PREFIX)) {
        handler.onConfigError(
          message.message
            .slice(FMT_SESSION_ERROR_PREFIX.length)
            .split('\n', 1)[0],
        );
      }
      handler.showErrorMessage(message.message);
      break;
    case MessageType.Warning:
      handler.showWarningMessage(message.message);
      break;
    default:
      handler.showInformationMessage(message.message);
      break;
  }
};

/**
 * Nonempty edits prove formatting succeeded. Empty edits are ambiguous: the
 * server also returns them on failure and deduplicates showMessage, so absence
 * of a new notification cannot prove recovery on a repeated request.
 */
export const clearEpisodeAfterSuccessfulFormatting = (
  episode: NotInstalledEpisode,
  failuresBeforeRequest: number,
  failuresAfterRequest: number,
  editCount: number,
): boolean => {
  if (editCount <= 0 || failuresBeforeRequest !== failuresAfterRequest)
    return false;
  episode.clear();
  return true;
};
