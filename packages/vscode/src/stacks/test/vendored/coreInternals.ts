/**
 * Vendored from `web-infra-dev/rstest` @ origin/main:
 * - `packages/core/src/utils/constants.ts` (`ROOT_SUITE_NAME`)
 * - `packages/core/src/utils/error.ts` (`parseErrorStacktrace`)
 *
 * Upstream's VS Code extension lives in the same monorepo and deep-imports both
 * from `../../core/src/...`. Neither is reachable from the published package:
 * `@rstest/core`'s exports map is `.`, `./api`, `./internal/adapter`,
 * `./internal/browser`, `./internal/browser-runtime`, `./package.json`,
 * `./globals`, `./importMeta` — so a standalone repo has to vendor them.
 *
 * TODO: ask `@rstest/core` to export these (an `./internal/host` subpath would
 * delete this file). Until then this is a trimmed copy:
 * - no `getSourcemap` branch. The only call site is
 *   `parseErrorStacktrace({ stack })` in `testRunReporter.ts`, which never
 *   passes one, so `@jridgewell/trace-mapping` is not pulled in.
 * - no `isDebug()` default for `fullStack`. That helper lives in core's logger
 *   and keys off core's own `DEBUG` handling, which does not exist in the
 *   extension host; the caller does not pass the flag either.
 *
 * The stack-frame filtering — `stackIgnores`, the http-like-file rejection and
 * the backslash normalization — is kept byte-identical, because it is what
 * decides which frame becomes the failure location in the editor.
 */
import { parse as stackTraceParse, type StackFrame } from 'stacktrace-parser';

export const ROOT_SUITE_NAME = 'Rstest:_internal_root_suite';

const isHttpLikeFile = (file: string): boolean => /^https?:\/\//.test(file);

const stackIgnores: (RegExp | string)[] = [
  /\/@rstest\/core/,
  /rstest\/packages\/core\/dist/,
  /node_modules\/chai/,
  /node_modules\/@vitest\/expect/,
  /node_modules\/@vitest\/snapshot/,
  /node:\w+/,
  /webpack\/runtime/,
  /rstest runtime/,
  // windows path
  /webpack\\runtime/,
  '<anonymous>',
];

export async function parseErrorStacktrace({
  stack,
  fullStack = false,
}: {
  fullStack?: boolean;
  stack: string;
}): Promise<StackFrame[]> {
  const stackFrames = stackTraceParse(stack).filter((frame) =>
    fullStack
      ? true
      : frame.file && !stackIgnores.some((entry) => frame.file?.match(entry)),
  );

  if (fullStack) {
    return stackFrames;
  }

  const filteredFrames = stackFrames.filter((frame) => {
    if (!frame.file) {
      return false;
    }

    if (isHttpLikeFile(frame.file)) {
      return false;
    }

    const normalizedFile = frame.file.replace(/\\/g, '/');
    return !stackIgnores.some((entry) => normalizedFile.match(entry));
  });

  return filteredFrames;
}
