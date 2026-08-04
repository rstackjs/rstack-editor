import type { StackContext, StackController } from '../../types';

/**
 * `rs fmt` is phase 2. Detection already lights the stack so
 * the status bar can tell the user it was found, but nothing is registered:
 * the MVP is a `DocumentFormattingEditProvider` spawning
 * `rs fmt --stdin-filepath <path>` with cwd = the directory containing
 * `rstack.config.*`, later replaced by the `rs fmt` LSP.
 */
class FmtController implements StackController {
  readonly id = 'fmt' as const;

  async register(context: StackContext): Promise<void> {
    context.output.info(
      'rs fmt detected, but formatting support is phase 2 and is not registered yet',
    );
    context.status.report({
      kind: 'disabled',
      reason: 'rs fmt support arrives in phase 2',
    });
  }

  dispose(): void {
    // Nothing registered yet (phase 2).
  }
}

export const createFmtController = (): StackController => new FmtController();
