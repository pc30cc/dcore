import path from 'node:path';
import { findBrandsDir, loadBrand } from '@app/config';
import { toPublicBrand } from '@app/shared';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';
import { brandIndexHtml, indexHtmlFor, panelLocaleOf } from './src/i18n/indexHtml';

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

/**
 * The panel's default language (sign-in pages included) for anyone who has
 * not picked one in its menu: ADMIN_DEFAULT_LOCALE (a development server's,
 * and the fallback a built bundle keeps), else Persian. A deployment picks
 * its own at run time (deploy/nginx/admin-runtime.sh); the brand's
 * `defaultLocale` stays the apps' and the website's.
 */
const panelLocale = panelLocaleOf(process.env['ADMIN_DEFAULT_LOCALE'], brand);

/**
 * Puts the brand's title and colour variables and the panel's language into
 * index.html, so the first paint is already branded and in that language,
 * and writes one copy per language of the brand (index.<locale>.html), which
 * the container serves for its ADMIN_DEFAULT_LOCALE.
 */
function brandHtml(): Plugin {
  const vars = [
    `--brand-light:${brand.colors.brand.light}`,
    `--brand-dark:${brand.colors.brand.dark}`,
    `--on-brand-light:${brand.colors.onBrand.light}`,
    `--on-brand-dark:${brand.colors.onBrand.dark}`,
    `--font-latin:${JSON.stringify(brand.fonts.latin)}`,
    `--font-persian:${JSON.stringify(brand.fonts.persian)}`,
  ].join(';');
  const page = { appName: brand.appName, defaultLocale: brand.defaultLocale, locales: brand.locales, style: `<style>:root{${vars}}</style>` };
  return {
    name: 'brand-html',
    transformIndexHtml(html) {
      return brandIndexHtml(html, page, panelLocale);
    },
  };
}

/** index.<locale>.html beside the built index.html, for every language of the brand. */
function localePages(): Plugin {
  return {
    name: 'locale-pages',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const index = bundle['index.html'];
      if (index?.type !== 'asset') throw new Error('the build wrote no index.html');
      const html = typeof index.source === 'string' ? index.source : new TextDecoder().decode(index.source);
      for (const locale of brand.locales) {
        this.emitFile({ type: 'asset', fileName: `index.${locale}.html`, source: indexHtmlFor(html, locale, brand.appName) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), brandHtml(), localePages()],
  define: {
    __BRAND__: JSON.stringify(brand),
    __ADMIN_DEFAULT_LOCALE__: JSON.stringify(panelLocale),
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
