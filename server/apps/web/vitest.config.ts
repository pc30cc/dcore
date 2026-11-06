import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@app/source'] },
  ssr: { resolve: { conditions: ['@app/source'] } },
  test: {
    include: ['test/**/*.test.ts'],
    // The site is built (twice) once before the tests that read the output.
    globalSetup: ['test/globalSetup.ts'],
    hookTimeout: 240_000,
  },
});
