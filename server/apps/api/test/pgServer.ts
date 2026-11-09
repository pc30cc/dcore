import { execFile } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * A PostgreSQL server of the suite's own (initdb in a temporary directory,
 * its own port), so a test can stop it and start it again without touching
 * the cluster the other suites share. Run as `postgres` when the tests run
 * as root (initdb refuses root).
 */

const run = promisify(execFile);

const BIN_DIRS = ['/usr/lib/postgresql/17/bin', '/usr/local/pgsql/bin'];
export const PG_BIN = BIN_DIRS.find((dir) => existsSync(join(dir, 'pg_ctl')) && existsSync(join(dir, 'initdb')));
if (!PG_BIN && process.env['REQUIRE_INTEGRATION'] === '1') throw new Error('REQUIRE_INTEGRATION=1 but PostgreSQL 17 server binaries are not installed');

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

function command(bin: string, args: string[]): [string, string[]] {
  const path = join(PG_BIN!, bin);
  return asRoot ? ['runuser', ['-u', 'postgres', '--', path, ...args]] : [path, args];
}

export interface PgServer {
  /** A superuser URL of the server's `postgres` database. */
  url: string;
  port: number;
  /** A URL of another database on it. */
  urlOf(database: string): string;
  /** Stops the server (`fast`: connections are terminated, new ones refused). */
  stop(): Promise<void>;
  start(): Promise<void>;
  /** Stops it and removes its files. */
  destroy(): Promise<void>;
}

export async function startPgServer(): Promise<PgServer> {
  if (!PG_BIN) throw new Error('PostgreSQL server binaries are not installed');
  const dir = mkdtempSync(join(tmpdir(), 'chat-pg-'));
  const data = join(dir, 'data');
  if (asRoot) {
    const uid = Number((await run('id', ['-u', 'postgres'])).stdout.trim());
    const gid = Number((await run('id', ['-g', 'postgres'])).stdout.trim());
    chownSync(dir, uid, gid);
    chmodSync(dir, 0o700);
  }
  const port = await freePort();
  const [initdb, initArgs] = command('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C.UTF-8', '-N']);
  await run(initdb, initArgs);
  const options = `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=60`;
  const pgCtl = (action: string, extra: string[] = []) => {
    const [bin, args] = command('pg_ctl', ['-D', data, '-w', '-t', '60', '-l', join(dir, 'server.log'), ...extra, action]);
    return run(bin, args);
  };
  await pgCtl('start', ['-o', options]);
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  return {
    url,
    port,
    urlOf: (database) => `postgres://postgres@127.0.0.1:${port}/${database}`,
    async stop() {
      await pgCtl('stop', ['-m', 'fast']);
    },
    async start() {
      await pgCtl('start', ['-o', options]);
    },
    async destroy() {
      await pgCtl('stop', ['-m', 'immediate']).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
