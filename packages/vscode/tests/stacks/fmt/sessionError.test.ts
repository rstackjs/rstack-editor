import { describe, expect, it, rs } from '@rstest/core';
import vscode from 'vscode';
import { NotInstalledEpisode } from '../../../src/shared/notInstalled';
import {
  classifyFmtSessionError,
  clearEpisodeAfterSuccessfulFormatting,
  FMT_SESSION_ERROR_PREFIX,
  handleFmtShowMessage,
} from '../../../src/stacks/fmt/sessionError';

rs.mock('vscode', () => ({
  default: {
    window: {
      showErrorMessage: rs.fn(),
      showWarningMessage: rs.fn(),
      showInformationMessage: rs.fn(),
    },
  },
}));

describe('classifyFmtSessionError', () => {
  const root = '/project';
  const configPath = '/project/rstack.config.ts';

  it('classifies the first line of the rs fmt config-loading error', () => {
    for (const errorPrefix of ['Error: ', 'Error [ERR_MODULE_NOT_FOUND]: ']) {
      expect(
        classifyFmtSessionError(
          {
            type: 1,
            message: `${FMT_SESSION_ERROR_PREFIX}${errorPrefix}Cannot find package 'missing' imported from /project/rstack.config.ts\nmore detail`,
          },
          root,
          configPath,
        ),
      ).toEqual({
        configPath: 'rstack.config.ts',
        cause:
          "Cannot find package 'missing' imported from /project/rstack.config.ts",
      });
    }
  });

  it('leaves unrelated messages and loader failures to the default UI', () => {
    expect(
      classifyFmtSessionError(
        { type: 2, message: 'warning' },
        root,
        configPath,
      ),
    ).toBe(undefined);
    expect(
      classifyFmtSessionError(
        {
          type: 1,
          message: `${FMT_SESSION_ERROR_PREFIX}SyntaxError: Unexpected token`,
        },
        root,
        configPath,
      ),
    ).toBe(undefined);
    expect(
      classifyFmtSessionError(
        {
          type: 1,
          message: "Cannot find package 'missing'",
        },
        root,
        configPath,
      ),
    ).toBe(undefined);
  });
});

describe('handleFmtShowMessage', () => {
  it('routes other message types to information without changing state', () => {
    for (const type of [4, 5] as const) {
      const information = rs.fn();
      const unexpected = rs.fn();
      handleFmtShowMessage(
        { type, message: 'message' },
        '/project',
        undefined,
        {
          showInformationMessage: information,
          showErrorMessage: unexpected,
          showWarningMessage: unexpected,
          onConfigDependency: unexpected,
        },
      );
      expect(information).toHaveBeenCalledExactlyOnceWith('message');
      expect(unexpected).not.toHaveBeenCalled();
    }
  });
  it('re-presents non-classified Error, Warning and Info messages without state changes', () => {
    const shown: string[] = [];
    let stateChanges = 0;
    const handler = {
      onConfigDependency: () => {
        stateChanges += 1;
      },
      showErrorMessage: (message: string) => shown.push(`error:${message}`),
      showWarningMessage: (message: string) => shown.push(`warning:${message}`),
      showInformationMessage: (message: string) =>
        shown.push(`information:${message}`),
    };

    for (const message of [
      { type: 1 as const, message: 'bad config syntax' },
      { type: 2 as const, message: 'deprecated option' },
      { type: 3 as const, message: 'formatter ready' },
    ]) {
      handleFmtShowMessage(message, '/project', '/project/rstack.config.ts', {
        ...vscode.window,
        onConfigDependency: handler.onConfigDependency,
      });
      handleFmtShowMessage(
        message,
        '/project',
        '/project/rstack.config.ts',
        handler,
      );
    }

    expect(shown).toEqual([
      'error:bad config syntax',
      'warning:deprecated option',
      'information:formatter ready',
    ]);
    expect(stateChanges).toBe(0);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
      'bad config syntax',
    );
    expect(vscode.window.showWarningMessage).toHaveBeenCalledExactlyOnceWith(
      'deprecated option',
    );
    expect(
      vscode.window.showInformationMessage,
    ).toHaveBeenCalledExactlyOnceWith('formatter ready');
  });
});

describe('clearEpisodeAfterSuccessfulFormatting', () => {
  it('clears the warning latch only after a request without a config failure', () => {
    const episode = new NotInstalledEpisode();
    episode.observe('fmt', 'rstack.config.ts', "Cannot find package 'missing'");

    expect(clearEpisodeAfterSuccessfulFormatting(episode, 0, 1, 0)).toBe(false);
    expect(episode.active).toBe(true);
    expect(clearEpisodeAfterSuccessfulFormatting(episode, 1, 1, 0)).toBe(false);
    expect(episode.active).toBe(true);

    expect(clearEpisodeAfterSuccessfulFormatting(episode, 1, 1, 1)).toBe(true);
    expect(episode.active).toBe(false);
    expect(
      episode.observe(
        'fmt',
        'rstack.config.ts',
        "Cannot find package 'missing'",
      ).warning,
    ).toContain("Cannot find package 'missing'");
  });
});
