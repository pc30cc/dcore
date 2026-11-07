// Container health check of the worker, which serves no HTTP. Healthy when
// kv-core answers PING with this process's REDIS_URL credentials and
// PostgreSQL (DATABASE_URL's host and port) accepts a TCP connection.
// Dependency-free on purpose: it runs from the image's /app, beside the
// worker, with plain node.
import net from 'node:net';
import tls from 'node:tls';

const TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS ?? 3000);

function fail(message) {
  console.error(`worker health: ${message}`);
  process.exit(1);
}

/** One RESP command as bytes. */
function command(...args) {
  return `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;
}

function redisPing(raw) {
  const url = new URL(raw);
  const port = Number(url.port || 6379);
  const host = url.hostname;
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  const auth = pass ? (user && user !== 'default' ? command('AUTH', user, pass) : command('AUTH', pass)) : '';
  return new Promise((resolve, reject) => {
    const socket = url.protocol === 'rediss:' ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buffer = '';
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('redis: timeout')));
    socket.once('error', reject);
    socket.once(url.protocol === 'rediss:' ? 'secureConnect' : 'connect', () => socket.write(auth + command('PING')));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('-')) {
        const line = buffer.split('\r\n').find((l) => l.startsWith('-'));
        if (line) {
          socket.destroy();
          reject(new Error(`redis: ${line.slice(1).split(' ')[0]}`));
          return;
        }
      }
      if (buffer.includes('+PONG\r\n')) {
        socket.end();
        resolve();
      }
    });
  });
}

function tcpCheck(raw) {
  const url = new URL(raw);
  const port = Number(url.port || 5432);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port });
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('postgres: timeout')));
    socket.once('error', (error) => reject(new Error(`postgres: ${error.code ?? error.message}`)));
    socket.once('connect', () => {
      socket.end();
      resolve();
    });
  });
}

const redisUrl = process.env.REDIS_URL;
const databaseUrl = process.env.DATABASE_URL;
if (!redisUrl) fail('REDIS_URL is not set');
if (!databaseUrl) fail('DATABASE_URL is not set');

try {
  await redisPing(redisUrl);
  await tcpCheck(databaseUrl);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
process.exit(0);
