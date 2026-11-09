import type { PublicBrand } from '@app/shared';

declare global {
  /** What the build keeps of the brand (vite.config.ts): names, colours, fonts, languages; never a host. */
  const __BRAND__: Pick<PublicBrand, 'id' | 'appName' | 'shortName' | 'colors' | 'fonts' | 'defaultLocale' | 'locales'>;

  interface ImportMetaEnv {
    /** A development server's API origin (default http://localhost:8080); a built panel reads /config.js instead. */
    readonly VITE_API_BASE_URL?: string;
  }
}

export {};
