import { createHash } from 'node:crypto';

/** Google Identity Services, as its documentation lists it for a Content-Security-Policy. */
const GIS = {
  script: 'https://accounts.google.com/gsi/client',
  frame: 'https://accounts.google.com/gsi/',
  connect: 'https://accounts.google.com/gsi/',
  style: 'https://accounts.google.com/gsi/style',
};

export function scriptHash(source: string): string {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

export interface CspOptions {
  /** The exact text of each inline script on the page. */
  inlineScripts?: readonly string[] | undefined;
  /** Where the page's forms may post (the API origin); none when the page has no form. */
  formAction?: readonly string[] | undefined;
  /** The page loads Google Identity Services (the deletion page's Google button). */
  google?: boolean | undefined;
}

/**
 * The page's Content-Security-Policy (sent as a `<meta>`, the site being
 * static files): its own files only, inline scripts by hash, forms only to
 * the API and back here (the API answers a form post with a redirect to this
 * site, which `form-action` also governs).
 */
export function contentSecurityPolicy(options: CspOptions = {}): string {
  const inline = (options.inlineScripts ?? []).map(scriptHash);
  const google = options.google === true;
  const script = [...inline, ...(google ? [GIS.script] : [])];
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', script.length > 0 ? script : ["'none'"]],
    ['style-src', ["'self'", "'unsafe-inline'", ...(google ? [GIS.style] : [])]],
    ['img-src', ["'self'", 'data:']],
    ['font-src', ["'self'"]],
    ['connect-src', google ? ["'self'", GIS.connect] : ["'self'"]],
    ['frame-src', google ? [GIS.frame] : ["'none'"]],
    ['form-action', options.formAction && options.formAction.length > 0 ? [...options.formAction, "'self'"] : ["'none'"]],
    ['base-uri', ["'none'"]],
    ['object-src', ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}
