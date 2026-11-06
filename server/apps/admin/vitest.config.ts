import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['@app/source'],
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  ssr: { resolve: { conditions: ['@app/source'] } },
  define: {
    __BRAND__: JSON.stringify({ appName: 'Test', defaultLocale: 'en', locales: ['en', 'fa', 'tr'] }),
  },
  test: { include: ['test/**/*.test.ts'] },
});
