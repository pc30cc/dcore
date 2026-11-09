import type { RuntimeConfig } from './runtimeConfig';

/**
 * Loads the run-time Persian font when the deployment names one: a
 * stylesheet with its @font-face rules (the panel's CSP allows that origin)
 * and its family name, put first in `--font-persian`. No font file is part
 * of the build; without the setting the brand's font name and the system's
 * fonts apply. The font files are fetched with CORS, so their host must send
 * Access-Control-Allow-Origin for the panel's origin.
 */
export function applyRuntimeFont(font: RuntimeConfig['persianFont'], doc: Document = document): void {
  if (!font) return;
  if (!doc.head.querySelector('link[data-runtime-font]')) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = font.cssUrl;
    link.referrerPolicy = 'no-referrer';
    link.dataset.runtimeFont = '';
    doc.head.appendChild(link);
  }
  doc.documentElement.style.setProperty('--font-persian', `"${font.family}"`);
}
