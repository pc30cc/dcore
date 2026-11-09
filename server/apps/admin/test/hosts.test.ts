import { describe, expect, it } from 'vitest';
import { problemError } from '../src/lib/api';
import { checkForm, formOf, problemsOf, requestOf } from '../src/lib/hosts';
import { originOf, readRuntimeConfig } from '../src/lib/runtimeConfig';

describe('the run-time configuration (/config.js)', () => {
  it('takes the API and CDN origins the container wrote', () => {
    expect(readRuntimeConfig({ apiOrigin: 'https://api.example.com', cdnOrigin: 'https://cdn.example.com' }, false, undefined)).toEqual({
      ok: true,
      config: { apiOrigin: 'https://api.example.com', cdnOrigin: 'https://cdn.example.com' },
    });
    // admin-runtime.sh writes an empty CDN origin when none is configured.
    expect(readRuntimeConfig({ apiOrigin: 'https://api.example.com', cdnOrigin: '' }, false, undefined)).toEqual({
      ok: true,
      config: { apiOrigin: 'https://api.example.com', cdnOrigin: null },
    });
  });

  it('refuses a configuration without a usable API origin, and never falls back in a built panel', () => {
    expect(readRuntimeConfig({ apiOrigin: 'http://api.example.com' }, false, undefined).ok).toBe(false);
    expect(readRuntimeConfig({ apiOrigin: 'https://api.example.com/v1' }, false, undefined).ok).toBe(false);
    expect(readRuntimeConfig(undefined, false, 'http://localhost:8080')).toEqual({ ok: false, reason: '/config.js was not loaded' });
  });

  it('uses VITE_API_BASE_URL, else the local API, on a development server', () => {
    expect(readRuntimeConfig(undefined, true, undefined)).toEqual({ ok: true, config: { apiOrigin: 'http://localhost:8080', cdnOrigin: null } });
    expect(readRuntimeConfig(undefined, true, 'https://staging-api.example.com')).toEqual({
      ok: true,
      config: { apiOrigin: 'https://staging-api.example.com', cdnOrigin: null },
    });
    // The file wins over the development default when a server provides one.
    expect(readRuntimeConfig({ apiOrigin: 'https://api.example.com' }, true, undefined)).toMatchObject({ ok: true, config: { apiOrigin: 'https://api.example.com' } });
  });

  it('accepts plain http for a local address only', () => {
    expect(originOf('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(originOf('http://10.0.0.5:8080')).toBeNull();
    expect(originOf('https://user:pw@api.example.com')).toBeNull();
    expect(originOf('https://api.example.com/')).toBe('https://api.example.com');
  });
});

describe('API errors', () => {
  it('reads the code, the detail and the field issues of a problem document', () => {
    const error = problemError(
      422,
      JSON.stringify({ type: 'urn:problem-type:field-invalid', title: 'Field not valid', status: 422, code: 'field_invalid', detail: 'must use https', errors: [{ in: 'body', pointer: '/hosts/api/0', code: 'invalid', message: 'must use https' }] }),
    );
    expect(error).toMatchObject({ status: 422, code: 'field_invalid', message: 'must use https' });
    expect(error.errors).toEqual([{ in: 'body', pointer: '/hosts/api/0', code: 'invalid', message: 'must use https' }]);
    expect(problemError(502, '<html>bad gateway</html>')).toMatchObject({ status: 502, code: 'http_502' });
  });
});

describe('the Hosts form', () => {
  const view = {
    hosts: { api: ['https://api.example.com', 'https://api.example.net'], realtime: ['https://rt.example.com'], rtc: [], cdn: ['https://cdn.example.com'], web: ['https://example.com'] },
    bootstrap: ['https://cdn.example.com/bootstrap/origins.json'],
    allowIpHosts: false,
  };

  it('round-trips the stored hosts, one per line, dropping blank lines and spaces', () => {
    const form = formOf(view);
    expect(form.lines.api).toBe('https://api.example.com\nhttps://api.example.net');
    expect(requestOf({ ...form, lines: { ...form.lines, rtc: '\n  https://rtc.example.com  \n\n' } }, 4)).toEqual({
      hosts: { ...view.hosts, rtc: ['https://rtc.example.com'] },
      bootstrap: view.bootstrap,
      allowIpHosts: false,
      baseVersion: 4,
    });
  });

  it('checks the API rules before sending, naming the field and the entry', () => {
    const form = formOf(view);
    expect(checkForm(form)).toEqual([]);
    expect(checkForm({ ...form, lines: { ...form.lines, api: '' } })).toEqual([{ field: 'api', message: 'at least one API host is required' }]);
    expect(checkForm({ ...form, lines: { ...form.lines, api: 'https://api.example.com\nhttp://api.example.org', cdn: 'https://203.0.113.9' } })).toEqual([
      { field: 'api', line: 2, message: 'must use https' },
      { field: 'cdn', line: 1, message: 'an IP address is not allowed here (allowIpHosts is off)' },
    ]);
    expect(checkForm({ ...form, allowIpHosts: true, lines: { ...form.lines, cdn: 'https://8.8.8.8' } })).toEqual([]);
  });

  it('maps the API\'s pointers to fields', () => {
    expect(problemsOf([{ pointer: '/bootstrap/1', message: 'must not carry a query' }, { pointer: '/hosts/web', message: 'at most 8 entries' }, { pointer: '/other', message: 'x' }])).toEqual([
      { field: 'bootstrap', line: 2, message: 'must not carry a query' },
      { field: 'web', message: 'at most 8 entries' },
    ]);
  });
});
