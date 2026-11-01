import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'apps/desktop/test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
