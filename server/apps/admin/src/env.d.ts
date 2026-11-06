import type { PublicBrand } from '@app/shared';

declare global {
  /** The build's brand, defined by vite.config.ts. */
  const __BRAND__: PublicBrand;

  interface ImportMetaEnv {
    /** The API's origin, e.g. https://api.example.com. */
    readonly VITE_API_BASE_URL?: string;
  }
}

export {};
