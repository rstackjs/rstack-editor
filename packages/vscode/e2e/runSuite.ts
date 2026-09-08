import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import Mocha from 'mocha';

const collectTests = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return collectTests(full);
    }
    return full.endsWith('.test.js') ? [full] : [];
  });

/**
 * The extension host's entry point into a VS Code slice suite. VS Code calls
 * the returned function once the window has started, so tests observe the real
 * `onStartupFinished` activation instead of forcing it.
 */
export const createRun = (testPath: string): (() => Promise<void>) => {
  return () => {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 120_000 });
    for (const file of collectTests(testPath)) {
      mocha.addFile(file);
    }

    return new Promise((resolve, reject) => {
      try {
        // Mocha's reporter writes to the extension host's stdout, which never
        // reaches the harness log — the rejection message is the only channel
        // that does, so it must name the failures itself.
        const failed: string[] = [];
        const runner = mocha.run((failures) => {
          if (failures > 0) {
            reject(
              new Error(
                `${failures} E2E test(s) failed:\n${failed.join('\n')}`,
              ),
            );
          } else {
            resolve();
          }
        });
        runner.on('fail', (test, error) => {
          failed.push(
            `- ${test.fullTitle()}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
};
