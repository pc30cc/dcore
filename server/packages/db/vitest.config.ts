import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@app/source'] },
  ssr: { resolve: { conditions: ['@app/source'] } },
  test: {
    include: ['test/**/*.test.ts'],
    // Each test file creates and drops its own temporary database.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
