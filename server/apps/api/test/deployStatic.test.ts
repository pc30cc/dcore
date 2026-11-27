import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request, type Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEPLOY } from './deploySupport.js';

/**
 * The static sites (admin panel, website) and the media origin as their
 * images serve them, run on a real nginx with the repository's configs:
 * every HTML response (pages, the SPA's index, nginx's own error pages, the
 * redirects) says `no-transform` in a single Cache-Control, so a proxy or
 * CDN in front injects no script and rewrites no markup, while assets and
 * JSON keep their caching. Needs nginx; REQUIRE_INTEGRATION=1 turns its
 * absence into a failure.
 */

const has = (command: string) => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;
const available = has('nginx');
if (!available && process.env['REQUIRE_INTEGRATION'] === '1') throw new Error('REQUIRE_INTEGRATION=1 but nginx is missing');

function replaceAll(text: string, pairs: [string, string][]): string {
  let out = text;
  for (const [from, to] of pairs) {
    if (!out.includes(from)) throw new Error(`"${from}" is not in the config any more: update this test`);
    out = out.split(from).join(to);
  }
  return out;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

interface Answer {
  status: number;
  type: string;
  cacheControl: string[];
  headers: string[];
  etag: string;
}

function fetchRaw(port: number, path: string, method = 'GET', headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { accept: 'text/html', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => {
        const raw = res.rawHeaders;
        const names: string[] = [];
        const cacheControl: string[] = [];
        for (let i = 0; i < raw.length; i += 2) {
          names.push(raw[i]!.toLowerCase());
          if (raw[i]!.toLowerCase() === 'cache-control') cacheControl.push(raw[i + 1]!);
        }
        resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), cacheControl, headers: names, etag: String(res.headers.etag ?? '') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function listening(port: number): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetchRaw(port, '/healthz');
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

const NO_TRANSFORM = /(^|,\s*)no-transform(\s*,|$)/;

const OBJECT = 'jpg';
const OBJECT_TAG = '"v1"';

/**
 * Stands in for the object store behind the media origin: while `up`, it
 * answers as S3 does (the object, a part of it, not modified, its XML refusal
 * of a range past the end); otherwise it drops the connection (nginx's 502).
 */
function objectStore(state: { up: boolean }): Server {
  return createHttpServer((req, res) => {
    if (!state.up) {
      req.socket.destroy();
      return;
    }
    const headers = { 'cache-control': 'no-cache', etag: OBJECT_TAG, 'accept-ranges': 'bytes', 'x-amz-request-id': 'r' };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (req.headers['if-none-match'] === OBJECT_TAG) {
      res.writeHead(304, headers).end();
    } else if (range && Number(range[1]) >= OBJECT.length) {
      res.writeHead(416, { ...headers, 'content-type': 'application/xml' }).end('<Error><Code>InvalidRange</Code></Error>');
    } else if (range) {
      const start = Number(range[1]);
      const end = Math.min(OBJECT.length - 1, range[2] ? Number(range[2]) : OBJECT.length - 1);
      res.writeHead(206, { ...headers, 'content-type': 'image/jpeg', 'content-range': `bytes ${start}-${end}/${OBJECT.length}` }).end(OBJECT.slice(start, end + 1));
    } else {
      res.writeHead(200, { ...headers, 'content-type': 'image/jpeg' }).end(OBJECT);
    }
  });
}

describe.skipIf(!available)('the static sites and the media origin on nginx (no-transform)', () => {
  const work = mkdtempSync(join(tmpdir(), 'static-nginx-'));
  const ports = { admin: 0, web: 0, media: 0 };
  let nginx: ChildProcess | undefined;
  const storeState = { up: false };
  const store = objectStore(storeState);

  function write(path: string, text: string): void {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }

  beforeAll(async () => {
    ports.admin = await freePort();
    ports.web = await freePort();
    ports.media = await freePort();
    await new Promise<void>((resolve) => store.listen(0, '127.0.0.1', resolve));
    const storeAddress = store.address();
    const storePort = typeof storeAddress === 'object' && storeAddress ? storeAddress.port : 0;
    const paths: [string, string][] = [
      ['/etc/nginx/snippets/', `${work}/snippets/`],
      ['/tmp/runtime/', `${work}/runtime/`],
    ];
    for (const name of ['headers.conf', 'admin-headers.conf', 'web-headers.conf']) {
      const text = readFileSync(join(DEPLOY, 'nginx', name), 'utf8');
      write(`snippets/${name}`, text.replaceAll('/etc/nginx/snippets/', `${work}/snippets/`).replaceAll('/tmp/runtime/', `${work}/runtime/`));
    }
    const csp = (args: string[]) => {
      const run = spawnSync(process.execPath, [join(DEPLOY, 'nginx/csp.mjs'), ...args], { encoding: 'utf8' });
      if (run.status !== 0) throw new Error(run.stderr);
      return run.stdout;
    };
    write('snippets/csp.conf', csp(['web']));
    write('admin/index.html', '<!doctype html><html><head><script>document.documentElement.dataset.t="1"</script></head><body></body></html>');
    write('admin/assets/app.js', 'export {};\n');
    write(
      'runtime/csp.conf',
      csp(['admin', join(work, 'admin/index.html')])
        .replaceAll('@API_ORIGIN@', 'https://api.example.com')
        .replaceAll('@CDN_ORIGIN@', '')
        .replaceAll('@FONT_ORIGIN@', ''),
    );
    write('runtime/config.js', 'window.__APP_CONFIG__ = Object.freeze({});\n');
    write('runtime/config.json', '{}\n');
    write('web/en/index.html', '<!doctype html><title>en</title>');
    write('web/404.html', '<!doctype html><title>404</title>');
    write('web/_astro/a.css', 'body{}\n');
    write('web/media/a.png', 'png');
    write('web/.well-known/assetlinks.json', '[]\n');
    write('web/robots.txt', 'User-agent: *\n');

    const admin = replaceAll(readFileSync(join(DEPLOY, 'nginx/admin.conf'), 'utf8'), [
      ['listen 8080;', `listen 127.0.0.1:${ports.admin};`],
      ['/usr/share/nginx/html', `${work}/admin`],
      ...paths,
    ]);
    const web = replaceAll(readFileSync(join(DEPLOY, 'nginx/web.conf'), 'utf8'), [
      ['listen 8080;', `listen 127.0.0.1:${ports.web};`],
      ['/usr/share/nginx/html', `${work}/web`],
      ['/etc/nginx/snippets/', `${work}/snippets/`],
    ]);
    // The media image's http block limits request bodies; the shared http block here does not.
    const bodyLimit = /^\s*client_max_body_size\s+([^;]+);/m.exec(readFileSync(join(DEPLOY, 'media/nginx.conf'), 'utf8'))?.[1];
    if (!bodyLimit) throw new Error('deploy/media/nginx.conf sets no client_max_body_size any more: update this test');
    const media = replaceAll(readFileSync(join(DEPLOY, 'media/media.conf.template'), 'utf8'), [
      ['listen 8080;', `listen 127.0.0.1:${ports.media};\n    client_max_body_size ${bodyLimit};`],
      ['@ORIGIN@', `127.0.0.1:${storePort}`],
      ['@BUCKET@', 'media'],
      ['@ORIGIN_SECRET@', 'x'.repeat(32)],
    ]);
    write('admin.conf', admin);
    write('web.conf', web);
    write('media.conf', media);
    const root = typeof process.getuid === 'function' && process.getuid() === 0;
    write(
      'nginx.conf',
      [
        root ? 'user root;' : '',
        `pid ${work}/nginx.pid;`,
        `error_log ${work}/error.log notice;`,
        'events { worker_connections 64; }',
        'http {',
        `  client_body_temp_path ${work}/client_temp;`,
        `  proxy_temp_path ${work}/proxy_temp;`,
        `  fastcgi_temp_path ${work}/fastcgi_temp;`,
        `  uwsgi_temp_path ${work}/uwsgi_temp;`,
        `  scgi_temp_path ${work}/scgi_temp;`,
        '  types { text/html html; text/css css; application/javascript js; application/json json; text/plain txt; image/png png; application/xml xml; }',
        '  default_type application/octet-stream;',
        '  access_log off;',
        // Stands in for njs verify.ok: one path passes as signed, to reach the store.
        '  map $uri $media_ok { default "0"; /signed/a.jpg "1"; }',
        `  include ${work}/admin.conf;`,
        `  include ${work}/web.conf;`,
        `  include ${work}/media.conf;`,
        '}',
      ].join('\n'),
    );
    nginx = spawn('nginx', ['-p', work, '-e', join(work, 'error.log'), '-c', join(work, 'nginx.conf'), '-g', 'daemon off;'], { stdio: 'ignore' });
    for (const port of Object.values(ports)) {
      if (!(await listening(port))) {
        let log = '';
        try {
          log = readFileSync(join(work, 'error.log'), 'utf8');
        } catch {
          // No log written.
        }
        throw new Error(`nginx did not start: ${log}`);
      }
    }
  }, 30_000);

  afterAll(() => {
    nginx?.kill('SIGTERM');
    store.close();
    rmSync(work, { recursive: true, force: true });
  });

  const html: [keyof typeof ports, string, string, number][] = [
    ['admin', 'GET', '/', 200],
    ['admin', 'GET', '/users/abc', 200],
    ['admin', 'GET', '/.env', 404],
    ['admin', 'POST', '/', 405],
    ['admin', 'GET', '/%', 400],
    ['admin', 'GET', '/assets/missing.js', 404],
    // A directory without an index: nginx's 403 would keep the location's year-long Cache-Control.
    ['admin', 'GET', '/assets/', 404],
    ['web', 'GET', '/en/', 200],
    ['web', 'GET', '/missing/', 404],
    ['web', 'GET', '/.git/config', 404],
    ['web', 'GET', '/_astro/missing.css', 404],
    ['web', 'GET', '/_astro/', 404],
    ['web', 'GET', '/media/', 404],
    ['web', 'GET', '/.well-known/', 404],
    ['web', 'GET', '/en', 301],
    ['web', 'POST', '/en/', 405],
    ['web', 'GET', '/%', 400],
    ['media', 'GET', '/a/b.jpg', 404],
    ['media', 'POST', '/a/b.jpg', 404],
    ['media', 'GET', '/%', 400],
    // The store down: nginx's own 502 page, not cached for the location's lifetime.
    ['media', 'GET', '/signed/a.jpg', 502],
    ['media', 'GET', '/bootstrap/origins.json', 502],
  ];

  it.each(html)('%s %s %s: HTML with a single Cache-Control that forbids transformation', async (site, method, path, status) => {
    const answer = await fetchRaw(ports[site], path, method);
    expect(answer.status).toBe(status);
    expect(answer.type).toMatch(/^text\/html/);
    expect(answer.cacheControl, JSON.stringify(answer.cacheControl)).toHaveLength(1);
    expect(answer.cacheControl[0]).toMatch(NO_TRANSFORM);
    if (site !== 'media') expect(answer.headers).toContain('x-content-type-options');
  });

  // Declared only, never sent: nginx refuses on the header, before reading a byte.
  const tooLarge = (bytes: number) => ({ 'content-length': String(bytes) });
  const changedSince = { 'if-unmodified-since': 'Thu, 01 Jan 1970 00:00:01 GMT' };
  // nginx's own error pages inside locations that cache their files (assets, run-time configuration, media).
  const errors: [keyof typeof ports, string, string, Record<string, string>, number][] = [
    ['admin', 'POST', '/assets/app.js', {}, 405],
    ['admin', 'DELETE', '/assets/app.js', {}, 405],
    ['admin', 'GET', '/assets/app.js', changedSince, 412],
    ['admin', 'GET', '/assets/app.js', tooLarge(2 * 1024 * 1024), 413],
    ['admin', 'POST', '/config.js', {}, 405],
    ['admin', 'POST', '/config.json', {}, 405],
    ['admin', 'GET', '/config.js', tooLarge(2 * 1024 * 1024), 413],
    ['web', 'POST', '/_astro/a.css', {}, 405],
    ['web', 'DELETE', '/_astro/a.css', {}, 405],
    ['web', 'GET', '/_astro/a.css', changedSince, 412],
    ['web', 'GET', '/_astro/a.css', tooLarge(2 * 1024 * 1024), 413],
    ['web', 'POST', '/media/a.png', {}, 405],
    ['web', 'POST', '/.well-known/assetlinks.json', {}, 405],
    // A page's URL: what depends on the request is not stored under it.
    ['web', 'POST', '/en/', {}, 405],
    ['web', 'GET', '/en/', changedSince, 412],
    ['web', 'GET', '/en/', tooLarge(2 * 1024 * 1024), 413],
    ['web', 'GET', '/missing/', tooLarge(2 * 1024 * 1024), 413],
    ['media', 'POST', '/a/b.jpg', tooLarge(2048), 413],
    ['media', 'GET', '/a/b.jpg', tooLarge(2048), 413],
    ['media', 'GET', '/signed/a.jpg', tooLarge(2048), 413],
    ['media', 'GET', '/bootstrap/origins.json', tooLarge(2048), 413],
  ];

  it.each(errors)('%s %s %s %j: an error page with a single Cache-Control that forbids storing and transformation', async (site, method, path, headers, status) => {
    const answer = await fetchRaw(ports[site], path, method, headers);
    expect(answer.status).toBe(status);
    expect(answer.type).toMatch(/^text\/html/);
    expect(answer.cacheControl).toEqual(['no-store, no-transform']);
    if (site !== 'media') expect(answer.headers).toContain('x-content-type-options');
  });

  it('keeps the caching of assets, run-time configuration and well-known files', async () => {
    const exact: [keyof typeof ports, string, string][] = [
      ['admin', '/assets/app.js', 'public, max-age=31536000, immutable'],
      ['admin', '/config.js', 'no-store, no-transform'],
      ['admin', '/config.json', 'no-store, no-transform'],
      ['web', '/_astro/a.css', 'public, max-age=31536000, immutable'],
      ['web', '/media/a.png', 'public, max-age=86400'],
      ['web', '/.well-known/assetlinks.json', 'public, max-age=3600'],
    ];
    for (const [site, path, value] of exact) {
      const answer = await fetchRaw(ports[site], path);
      expect(answer.status, `${site} ${path}`).toBe(200);
      expect(answer.cacheControl, `${site} ${path}`).toEqual([value]);
      const same = await fetchRaw(ports[site], path, 'GET', { 'if-none-match': answer.etag });
      expect(same.status, `${site} ${path} revalidated`).toBe(304);
      expect(same.cacheControl, `${site} ${path} revalidated`).toEqual([value]);
    }
  });

  it('caches a page, its revalidation, the 404 page and the slash redirect for 5 minutes', async () => {
    const page = await fetchRaw(ports.web, '/en/');
    expect(page.status).toBe(200);
    expect(page.cacheControl).toEqual(['public, max-age=300, no-transform']);
    const same = await fetchRaw(ports.web, '/en/', 'GET', { 'if-none-match': page.etag });
    expect(same.status).toBe(304);
    expect(same.cacheControl).toEqual(['public, max-age=300, no-transform']);
    for (const [path, status] of [
      ['/missing/', 404],
      ['/_astro/', 404],
      ['/en', 301],
    ] as const) {
      const answer = await fetchRaw(ports.web, path);
      expect(answer.status, path).toBe(status);
      expect(answer.cacheControl, path).toEqual(['public, max-age=300, no-transform']);
    }
  });

  // nginx sets a file's headers before it reads a Range, so its 416 page would carry them: every answer is the whole file.
  it.each([
    ['admin', '/', 'no-cache, no-transform'],
    ['admin', '/assets/app.js', 'public, max-age=31536000, immutable'],
    ['admin', '/config.js', 'no-store, no-transform'],
    ['web', '/en/', 'public, max-age=300, no-transform'],
    ['web', '/_astro/a.css', 'public, max-age=31536000, immutable'],
    ['web', '/media/a.png', 'public, max-age=86400'],
    ['web', '/.well-known/assetlinks.json', 'public, max-age=3600'],
  ] as const)('%s %s: a byte range gets the whole file with its caching', async (site, path, value) => {
    for (const range of ['bytes=999999-', 'bytes=0-0']) {
      const answer = await fetchRaw(ports[site], path, 'GET', { range });
      expect(answer.status, range).toBe(200);
      expect(answer.cacheControl, range).toEqual([value]);
      expect(answer.headers, range).not.toContain('accept-ranges');
    }
  });

  it('keeps the caching of what the store serves and caches none of its refusals', async () => {
    storeState.up = true;
    try {
      const rows: [string, Record<string, string>, number, string][] = [
        ['/signed/a.jpg', {}, 200, 'public, max-age=86400'],
        ['/signed/a.jpg', { range: 'bytes=0-0' }, 206, 'public, max-age=86400'],
        ['/signed/a.jpg', { 'if-none-match': OBJECT_TAG }, 304, 'public, max-age=86400'],
        ['/signed/a.jpg', { range: 'bytes=999999-' }, 416, 'no-store, no-transform'],
        ['/bootstrap/origins.json', {}, 200, 'public, max-age=300'],
        ['/bootstrap/origins.json', { 'if-none-match': OBJECT_TAG }, 304, 'public, max-age=300'],
        ['/bootstrap/origins.json', { range: 'bytes=999999-' }, 416, 'no-store, no-transform'],
      ];
      for (const [path, headers, status, value] of rows) {
        const answer = await fetchRaw(ports.media, path, 'GET', headers);
        const label = `${path} ${JSON.stringify(headers)}`;
        expect(answer.status, label).toBe(status);
        expect(answer.cacheControl, label).toEqual([value]);
        expect(answer.headers, label).not.toContain('x-amz-request-id');
      }
    } finally {
      storeState.up = false;
    }
  });

  it('serves the health checks uncached', async () => {
    for (const port of Object.values(ports)) {
      const answer = await fetchRaw(port, '/healthz');
      expect(answer.status).toBe(200);
      expect(answer.cacheControl).toEqual(['no-store, no-transform']);
    }
  });
});
