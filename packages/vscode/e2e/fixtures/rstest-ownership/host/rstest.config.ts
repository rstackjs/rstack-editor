import path from 'node:path';
import { defineConfig } from '@rstest/core';

export default defineConfig({
  resolve: {
    alias: {
      '@host-value': path.resolve(__dirname, 'value.ts'),
    },
  },
});
