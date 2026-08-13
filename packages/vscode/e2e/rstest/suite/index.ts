import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import Mocha from 'mocha';

const collectTests = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        return collectTests(full);
      }
      return full.endsWith('.test.js') ? [full] : [];
    });

/**
 * The extension host's entry point into the ported Rstest suites (upstream
 * `tests/suite/index.ts`). VS Code calls `run()` once the window has started,
 * so the tests observe the real `onStartupFinished` activation.
 *
 * The timeout is larger than upstream's 20s: the fixtures resolve the
 * *published* `@rstest/core` from their own node_modules, and
 * the first worker spawn in a cold Electron pays the whole Rstest/Rspack init.
 */
export function run(): Promise<void> {
  process.env.FORCE_COLOR = '1';
  process.env.NO_COLOR = '';

  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 120_000 });
  for (const file of collectTests(__dirname)) {
    mocha.addFile(file);
  }

  return new Promise((resolve, reject) => {
    try {
      const runner = mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} Rstest E2E test(s) failed.`));
        } else {
          resolve();
        }
      });
      // Mocha's reporter writes to the extension host's stdout, which the CI
      // test runner does not forward — a failing run's log shows only the
      // final count. `console.error` does reach it, so name each failure
      // there; without this, a CI-only failure cannot even be identified.
      runner.on('fail', (test, error: unknown) => {
        console.error(
          `[e2e-fail] ${test.fullTitle()}: ${
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error)
          }`,
        );
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
