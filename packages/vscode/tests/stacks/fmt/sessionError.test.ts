import { describe, expect, it } from '@rstest/core';
import {
  classifyFmtSessionError,
  FMT_SESSION_ERROR_PREFIX,
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
