import { readFileSync } from 'node:fs';
import { brandSchema } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { PublicHostError, withPublicHosts } from '../src/lib/publicHosts';

const template = brandSchema.parse(JSON.parse(readFileSync(new URL('../../../../brands/_template/brand.json', import.meta.url), 'utf8')));

describe('the site\'s public hosts from the build environment', () => {
  it('keeps brand.json when nothing is set', () => {
    expect(withPublicHosts(template, {})).toBe(template);
    expect(withPublicHosts(template, { PUBLIC_SITE_URL: '', PUBLIC_LINKS_URL: ' ' })).toBe(template);
  });

  it('moves the site, its legal links and the app links with PUBLIC_SITE_URL', () => {
    const moved = withPublicHosts(template, { PUBLIC_SITE_URL: 'https://www.example.org/' });
    expect(moved.domains.legal).toBe('www.example.org');
    expect(moved.domains.links).toBe('www.example.org');
    expect(moved.domains.api).toBe(template.domains.api);
    expect(moved.legal.privacyUrl).toBe('https://www.example.org/privacy');
    expect(moved.legal.deleteAccountUrl).toBe('https://www.example.org/delete-account');
    expect(moved.legal.supportEmail).toBe(template.legal.supportEmail);
    // The input is not changed.
    expect(template.domains.legal).toBe('example.com');
  });

  it('takes a separate app-links host, and a bare host for either', () => {
    const moved = withPublicHosts(template, { PUBLIC_SITE_URL: 'example.org', PUBLIC_LINKS_URL: 'https://go.example.org' });
    expect(moved.domains).toMatchObject({ legal: 'example.org', links: 'go.example.org' });
    expect(withPublicHosts(template, { PUBLIC_LINKS_URL: 'go.example.org' }).domains).toMatchObject({ legal: 'example.com', links: 'go.example.org' });
  });

  it('refuses what canonical links cannot be built for', () => {
    expect(() => withPublicHosts(template, { PUBLIC_SITE_URL: 'http://example.org' })).toThrow(PublicHostError);
    expect(() => withPublicHosts(template, { PUBLIC_SITE_URL: 'https://example.org:8443' })).toThrow(/port 443/);
    expect(() => withPublicHosts(template, { PUBLIC_SITE_URL: 'https://example.org/site' })).toThrow(/without a path/);
    expect(() => withPublicHosts(template, { PUBLIC_SITE_URL: 'https://localhost' })).toThrow(/fully qualified/);
  });
});
