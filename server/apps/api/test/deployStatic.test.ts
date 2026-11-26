import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
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
}

function fetchRaw(port: number, path: string, method = 'GET'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { accept: 'text/html' } }, (res) => {
      res.resume();
      res.on('end', () => {
        const raw = res.rawHeaders;
        const names: string[] = [];
        const cacheControl: string[] = [];
        for (let i = 0; i < raw.length; i += 2) {
          names.push(raw[i]!.toLowerCase());
          if (raw[i]!.toLowerCase() === 'cache-control') cacheControl.push(raw[i + 1]!);
        }
        resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), cacheControl, headers: names });
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

describe.skipIf(!available)('the static sites and the media origin on nginx (no-transform)', () => {
  const work = mkdtempSync(join(tmpdir(), 'static-nginx-'));
  const ports = { admin: 0, web: 0, media: 0 };
  let nginx: ChildProcess | undefined;

  function write(path: string, text: string): void {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), text);
  }

  beforeAll(async () => {
    ports.admin = await freePort();
    ports.web = await freePort();
    ports.media = await freePort();
    const closed = await freePort();
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
    const media = replaceAll(readFileSync(join(DEPLOY, 'media/media.conf.template'), 'utf8'), [
      ['listen 8080;', `listen 127.0.0.1:${ports.media};`],
      ['@ORIGIN@', `127.0.0.1:${closed}`],
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
        // Stands in for njs verify.ok: one path passes as signed, to reach the store (a closed port here).
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

  it('keeps the caching of assets, run-time configuration and well-known files', async () => {
    const exact: [keyof typeof ports, string, string][] = [
      ['admin', '/assets/app.js', 'public, max-age=31536000, immutable'],
      ['admin', '/config.js', 'no-store'],
      ['admin', '/config.json', 'no-store'],
      ['web', '/_astro/a.css', 'public, max-age=31536000, immutable'],
      ['web', '/media/a.png', 'public, max-age=86400'],
      ['web', '/.well-known/assetlinks.json', 'public, max-age=3600'],
    ];
    for (const [site, path, value] of exact) {
      const answer = await fetchRaw(ports[site], path);
      expect(answer.status, `${site} ${path}`).toBe(200);
      expect(answer.cacheControl, `${site} ${path}`).toEqual([value]);
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
