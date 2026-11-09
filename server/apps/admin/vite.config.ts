import path from 'node:path';
import { findBrandsDir, loadBrand } from '@app/config';
import { isRtl, toPublicBrand } from '@app/shared';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

/**
 * The brand is read at build time (BRAND=<id>, default the neutral template)
 * and only its names, colours, fonts and languages reach the bundle; none is
 * written in the code. No host is part of the build: the panel reads its API
 * address at run time from /config.js, which the container writes when it
 * starts (src/lib/runtimeConfig.ts).
 */
const publicBrand = toPublicBrand(loadBrand({ brandsDir: findBrandsDir(import.meta.dirname) }));
const brand = {
  id: publicBrand.id,
  appName: publicBrand.appName,
  shortName: publicBrand.shortName,
  colors: publicBrand.colors,
  fonts: publicBrand.fonts,
  defaultLocale: publicBrand.defaultLocale,
  locales: publicBrand.locales,
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Puts the brand's title and colour variables into index.html, so the first paint is already branded. */
function brandHtml(): Plugin {
  const vars = [
    `--brand-light:${brand.colors.brand.light}`,
    `--brand-dark:${brand.colors.brand.dark}`,
    `--on-brand-light:${brand.colors.onBrand.light}`,
    `--on-brand-dark:${brand.colors.onBrand.dark}`,
    `--font-latin:${JSON.stringify(brand.fonts.latin)}`,
    `--font-persian:${JSON.stringify(brand.fonts.persian)}`,
  ].join(';');
  return {
    name: 'brand-html',
    transformIndexHtml(html) {
      return html
        .replace('%APP_TITLE%', escapeHtml(`${brand.appName} Admin`))
        .replace('%BRAND_STYLE%', `<style>:root{${vars}}</style>`)
        .replace('%DEFAULT_LOCALE%', brand.defaultLocale)
        .replace('%DEFAULT_DIR%', isRtl(brand.defaultLocale) ? 'rtl' : 'ltr')
        .replace('%LOCALES%', JSON.stringify(brand.locales))
        .replace('%RTL_LOCALES%', JSON.stringify(brand.locales.filter((locale) => isRtl(locale))));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), brandHtml()],
  define: {
    __BRAND__: JSON.stringify(brand),
  },
  resolve: {
    // Workspace packages are bundled from their TypeScript source.
    conditions: ['@app/source', ...defaultClientConditions],
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 600,
  },
});
