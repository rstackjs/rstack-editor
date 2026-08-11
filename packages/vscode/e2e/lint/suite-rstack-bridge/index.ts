import { createRun } from '../runSuite';

// A bridged folder lights the lint stack exactly like a native one: the shell
// registers the controller, and only then does the capability gate decide
// whether a language server actually starts.
export const run = createRun();
