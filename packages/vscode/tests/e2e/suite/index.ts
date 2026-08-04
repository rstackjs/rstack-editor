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
 * The extension host's entry point into the suite. VS Code calls `run()` once
 * the window has started, so the tests observe the real `onStartupFinished`
 * activation instead of forcing it.
 */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 120_000 });
  for (const file of collectTests(__dirname)) {
    mocha.addFile(file);
  }

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} E2E test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
