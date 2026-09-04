import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import Mocha from 'mocha';

const collectTests = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory()
      ? collectTests(full)
      : full.endsWith('.test.js')
        ? [full]
        : [];
  });

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 120_000 });
  collectTests(__dirname).forEach((file) => mocha.addFile(file));
  return new Promise((resolve, reject) => {
    const failed: string[] = [];
    const runner = mocha.run((failures) => {
      if (failures === 0) resolve();
      else
        reject(
          new Error(`${failures} E2E test(s) failed:\n${failed.join('\n')}`),
        );
    });
    runner.on('fail', (test, error) => {
      failed.push(
        `- ${test.fullTitle()}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });
}
