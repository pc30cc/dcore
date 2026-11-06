import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@app/source'] },
  ssr: { resolve: { conditions: ['@app/source'] } },
  test: { include: ['test/**/*.test.ts'] },
});
