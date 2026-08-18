import { parseWorkerArgs } from './cli';
import { runLintWorker } from './index';
import { logger } from './logger';

async function main(): Promise<void> {
  const options = parseWorkerArgs(process.argv.slice(2));
  process.exitCode = await runLintWorker(options);
}

void main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error), error);
  process.exitCode = 1;
});
