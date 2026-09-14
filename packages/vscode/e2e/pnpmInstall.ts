import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/**
 * Runs `pnpm install --frozen-lockfile --ignore-scripts` in `cwd`. pnpm 11
 * prints install errors (e.g. ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION) to
 * stdout, while execFile's error message carries only stderr, so a failure
 * rethrows with both streams appended.
 */
export async function pnpmInstallFrozen(cwd: string): Promise<void> {
  try {
    await execFile(
      'pnpm',
      ['install', '--frozen-lockfile', '--ignore-scripts'],
      {
        cwd,
        timeout: 90_000,
        // Windows needs a shell for pnpm's .cmd shim; the arguments are fixed
        // safe tokens and cwd is not interpolated.
        shell: process.platform === 'win32',
      },
    );
  } catch (error) {
    const { stdout = '', stderr = '' } = error as {
      stdout?: string;
      stderr?: string;
    };
    throw new Error(`${(error as Error).message}\n${stdout}${stderr}`, {
      cause: error,
    });
  }
}
