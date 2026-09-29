import type { Socket } from 'node:net';
import { createInterface } from 'node:readline';

export const DEBUG_PIPE_ENV = 'RSTACK_RSTEST_DEBUG_PIPE';
export const DEBUG_PIPE_TOKEN_ENV = 'RSTACK_RSTEST_DEBUG_PIPE_TOKEN';

// Debug launches have no Node IPC channel. Keep the same JSON wire values as
// the normal spawn transport, framing each message with a newline.
export const socketRpc = (
  socket: Socket,
  authenticate?: (token: string) => boolean,
) => ({
  post: (data: unknown) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(data)}\n`);
  },
  on: (fn: (data: unknown) => void) => {
    const lines = createInterface({ input: socket });
    lines.on('line', (line) => {
      if (socket.destroyed) return;
      if (authenticate) {
        if (!authenticate(line)) socket.destroy();
        else authenticate = undefined;
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch (error) {
        socket.destroy(error as Error);
        return;
      }
      fn(data);
    });
  },
});
