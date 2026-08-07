import { createRun } from '../runSuite';

// The no-config fixture must never light the lint stack (rslint is not
// zero-config).
export const run = createRun({ expectLintStack: false });
