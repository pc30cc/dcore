import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['@app/source'],
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  ssr: { resolve: { conditions: ['@app/source'] } },
  define: {
    __BRAND__: JSON.stringify({
      id: 'test',
      appName: 'Test',
      shortName: 'Test',
      colors: { brand: { light: '#5B21B6', dark: '#C4B5FD' }, onBrand: { light: '#FFFFFF', dark: '#1E1B4B' } },
      fonts: { latin: 'Inter', persian: 'Vazirmatn' },
      defaultLocale: 'en',
      locales: ['en', 'fa', 'tr'],
    }),
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    testTimeout: 20_000,
  },
});
