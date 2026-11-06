import pg from 'pg';

/**
 * Where the pool's connections go.
 *
 * - `postgres`: straight to PostgreSQL (or PgBouncer in session mode). The
 *   per-connection settings travel as startup parameters, so they cost no
 *   round trip.
 * - `pgbouncer`: PgBouncer in transaction mode. Each transaction may run on a
 *   different server connection, so session state set by a client is lost or,
 *   worse, leaks to another client; and PgBouncer refuses unknown startup
 *   parameters. Only `application_name` is sent (PgBouncer tracks it per
 *   client). The timeouts must then be set where every server connection gets
 *   them: `ALTER ROLE ... SET statement_timeout` and
 *   `idle_in_transaction_session_timeout`, or `connect_query` in pgbouncer.ini
 *   (infra/pgbouncer/pgbouncer.ini does both jobs in development).
 */
export type DatabaseTarget = 'postgres' | 'pgbouncer';

export interface PoolOptions {
  connectionString: string;
  /** Shows up in pg_stat_activity and the server log: name the process (`api`, `worker`). */
  applicationName: string;
  target?: DatabaseTarget | undefined;
  /** Connections per process. Keep it small: PgBouncer multiplexes, PostgreSQL pays per backend. */
  max?: number | undefined;
  /** Server-side limit for one statement; 0 disables it. */
  statementTimeoutMs?: number | undefined;
  /** Server-side limit for a transaction left open while idle; 0 disables it. */
  idleInTransactionTimeoutMs?: number | undefined;
  /** How long to wait for a connection (new or from the pool) before failing. */
  connectTimeoutMs?: number | undefined;
  /** Closes connections idle this long. */
  idleTimeoutMs?: number | undefined;
  /** Replaces connections older than this, so server-side memory and plans do not grow forever. */
  maxLifetimeSeconds?: number | undefined;
  ssl?: pg.ConnectionConfig['ssl'] | undefined;
  /**
   * Called when an idle connection fails (the server restarted, the network
   * dropped). Without a listener such an error would crash the process.
   */
  onError?: ((error: Error) => void) | undefined;
}

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export class NamedStatementError extends Error {
  constructor(name: string) {
    super(
      `named prepared statement "${name}" refused: statements are prepared unnamed so that ` +
        'PgBouncer in transaction mode can route each one to any server connection',
    );
    this.name = 'NamedStatementError';
  }
}

function assertUnnamed(args: readonly unknown[]): void {
  const [config] = args;
  if (config !== null && typeof config === 'object' && 'name' in config) {
    const { name } = config as { name?: unknown };
    if (typeof name === 'string' && name.length > 0) throw new NamedStatementError(name);
  }
}

/**
 * A client that refuses named prepared statements. node-pg prepares a named
 * statement once per connection and then only sends "execute"; behind
 * PgBouncer in transaction mode the next execute can land on a server
 * connection that never saw the statement. Unnamed statements are parsed on
 * every call, which is what PgBouncer needs. The guard is on for both targets,
 * so code written against a direct connection does not break behind PgBouncer.
 */
export class UnnamedStatementClient extends pg.Client {
  // The signature must accept every overload of pg.Client#query.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override query(...args: any[]): any {
    assertUnnamed(args);
    return (pg.Client.prototype.query as (...a: unknown[]) => unknown).apply(this, args);
  }
}

/** The client settings a pool hands to each new connection. Exported for tests. */
export function clientConfig(options: PoolOptions): pg.PoolConfig {
  const target = options.target ?? 'postgres';
  const config: pg.PoolConfig = {
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectTimeoutMs ?? 3_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    maxLifetimeSeconds: options.maxLifetimeSeconds ?? 1_800,
    keepAlive: true,
    Client: UnnamedStatementClient,
  };
  if (options.ssl !== undefined) config.ssl = options.ssl;
  if (target === 'postgres') {
    // Sent in the startup packet: applied to the session before the first query.
    const statementTimeout = options.statementTimeoutMs ?? 5_000;
    const idleInTransaction = options.idleInTransactionTimeoutMs ?? 10_000;
    if (statementTimeout > 0) config.statement_timeout = statementTimeout;
    if (idleInTransaction > 0) config.idle_in_transaction_session_timeout = idleInTransaction;
  }
  return config;
}

/**
 * Creates a connection pool. It opens no connection until the first query, so
 * building an app does not need the database to be up.
 */
export function createPool(options: PoolOptions): Pool {
  const pool = new pg.Pool(clientConfig(options));
  pool.on('error', (error) => {
    if (options.onError) options.onError(error);
    // Without a handler the error is only logged here; it must never be thrown.
    else console.error('postgres pool: idle connection failed', error);
  });
  return pool;
}
