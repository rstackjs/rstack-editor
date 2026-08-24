import type { StackState, StatusReporter } from '../../../src/types';

/**
 * A `StatusReporter` that records every state it is handed, in the shape the
 * shell's status bar would receive. One recorder for every suite that binds
 * the Rstest `status` singleton, so the double is not retyped per file.
 */
export const createStatusRecorder = (): {
  reporter: StatusReporter;
  reported: StackState[];
} => {
  const reported: StackState[] = [];
  const reporter: StatusReporter = {
    stack: 'rstest',
    report: (state) => reported.push(state),
    starting: (detail) => reported.push({ kind: 'starting', detail }),
    running: (detail) => reported.push({ kind: 'running', detail }),
    crashed: (detail) => reported.push({ kind: 'crashed', detail }),
    versionMismatch: (detail) =>
      reported.push({ kind: 'version-mismatch', detail }),
  };
  return { reporter, reported };
};
