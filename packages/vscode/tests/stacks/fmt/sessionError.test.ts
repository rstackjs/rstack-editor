import { describe, expect, it } from '@rstest/core';
import { ConfigDependencyEpisode } from '../../../src/shared/notInstalled';
import {
  classifyFmtSessionError,
  finishSuccessfulFormatting,
  FMT_SESSION_ERROR_PREFIX,
  handleFmtShowMessage,
  showMessagePresentation,
} from '../../../src/stacks/fmt/sessionError';

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

describe('showMessagePresentation', () => {
  it('matches vscode-languageclient default show-message routing', () => {
    expect(showMessagePresentation(1)).toBe('error');
    expect(showMessagePresentation(2)).toBe('warning');
    expect(showMessagePresentation(3)).toBe('information');
    expect(showMessagePresentation(4)).toBe('information');
    expect(showMessagePresentation(5)).toBe('information');
  });
});

describe('handleFmtShowMessage', () => {
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
      handleFmtShowMessage(message, '/project', undefined, handler);
    }

    expect(shown).toEqual([
      'error:bad config syntax',
      'warning:deprecated option',
      'information:formatter ready',
    ]);
    expect(stateChanges).toBe(0);
  });
});

describe('finishSuccessfulFormatting', () => {
  it('clears the warning latch only after a request without a config failure', () => {
    const episode = new ConfigDependencyEpisode();
    episode.observe('fmt', 'rstack.config.ts', "Cannot find package 'missing'");

    expect(finishSuccessfulFormatting(episode, 0, 1)).toBe(false);
    expect(episode.active).toBe(true);

    expect(finishSuccessfulFormatting(episode, 1, 1)).toBe(true);
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
