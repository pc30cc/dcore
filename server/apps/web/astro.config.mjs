// @ts-check
import { defineConfig } from 'astro/config';

/**
 * A fully static site: every page is HTML built ahead of time, no server code
 * runs at request time, nobody signs in. The brand (names, colours, domains,
 * support address) is read while building (BRAND=<id>, src/lib/brand.ts).
 */
const sourceConditions = ['@app/source'];

export default defineConfig({
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory' },
  // No client-side JavaScript is shipped; prefetching would add some.
  prefetch: false,
  devToolbar: { enabled: false },
  vite: {
    // Workspace packages are compiled from their TypeScript source.
    resolve: { conditions: sourceConditions },
    ssr: { resolve: { conditions: sourceConditions, externalConditions: sourceConditions } },
  },
});
