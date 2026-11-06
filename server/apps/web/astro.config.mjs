// @ts-check
import { defineConfig } from 'astro/config';
// The workspace root's Vite (the same version Astro builds with).
import { defaultClientConditions, defaultExternalConditions, defaultServerConditions } from 'vite';

/**
 * A fully static site: every page is HTML built ahead of time, no server code
 * runs at request time, nobody signs in. The brand (names, colours, domains,
 * support address) and the build settings are read while building
 * (BRAND=<id>, PUBLIC_API_ORIGIN, PUBLIC_GOOGLE_WEB_CLIENT_ID; src/lib/brand.ts
 * and src/lib/settings.ts).
 */
const SOURCE_CONDITION = '@app/source';

/**
 * Workspace packages (`@app/config`, `@app/shared`) are compiled from their
 * TypeScript source, so a clean install builds without building them first.
 * Their `exports` map that source under the `@app/source` condition. Astro
 * renders pages in its own Vite environments (`prerender` among them), which
 * do not inherit `ssr.resolve`, so the condition is added to every
 * environment here, in front of Vite's defaults for that environment.
 *
 * @returns {import('vite').Plugin}
 */
function workspaceSource() {
  return {
    name: 'workspace-source-condition',
    configEnvironment(name, options) {
      const client = (options.consumer ?? (name === 'client' ? 'client' : 'server')) === 'client';
      options.resolve ??= {};
      const conditions = options.resolve.conditions ?? (client ? defaultClientConditions : defaultServerConditions);
      if (!conditions.includes(SOURCE_CONDITION)) options.resolve.conditions = [SOURCE_CONDITION, ...conditions];
      if (!client) {
        const external = options.resolve.externalConditions ?? defaultExternalConditions;
        if (!external.includes(SOURCE_CONDITION)) options.resolve.externalConditions = [SOURCE_CONDITION, ...external];
      }
    },
  };
}

export default defineConfig({
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory' },
  // No client-side JavaScript is shipped; prefetching would add some.
  prefetch: false,
  devToolbar: { enabled: false },
  vite: {
    plugins: [workspaceSource()],
  },
});
