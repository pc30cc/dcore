import { brand, brandConfig, siteOrigin } from './brand';

/**
 * `/.well-known/security.txt` (RFC 9116). It must expire within a year; it
 * is built with the site, so a yearly rebuild keeps it valid.
 */
export function securityTxt(builtAt: Date): string {
  const expires = new Date(builtAt.getTime() + 365 * 24 * 60 * 60 * 1000);
  expires.setUTCHours(0, 0, 0, 0);
  const contact = brandConfig.legal.securityEmail ?? brand.legal.supportEmail;
  return [
    `Contact: mailto:${contact}`,
    `Expires: ${expires.toISOString()}`,
    `Preferred-Languages: ${brand.locales.join(', ')}`,
    `Canonical: ${siteOrigin}/.well-known/security.txt`,
    '',
  ].join('\n');
}
