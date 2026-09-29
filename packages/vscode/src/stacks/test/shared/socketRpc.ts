import type { Socket } from 'node:net';
import { createInterface } from 'node:readline';

// Debug launches have no Node IPC channel. Keep the same JSON wire values as
// the normal spawn transport, framing each message with a newline.
export const socketRpc = (socket: Socket) => ({
  post: (data: unknown) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(data)}\n`);
  },
  on: (fn: (data: unknown) => void) => {
    const lines = createInterface({ input: socket });
    lines.on('line', (line) => {
      try {
        fn(JSON.parse(line));
      } catch (error) {
        socket.destroy(error as Error);
      }
    });
    socket.once('close', () => lines.close());
  },
});
