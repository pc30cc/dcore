import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigError } from '@app/config';
import { buildApp, createLogger } from './app.js';
import { loadConfig } from './config.js';

/**
 * The API process: listen, then stop cleanly on SIGTERM/SIGINT.
 *
 * Shutdown: /readyz turns to 503 at once (the load balancer stops sending new
 * traffic), the server keeps serving for SHUTDOWN_DRAIN_MS, then closes:
 * in-flight requests finish, idle keep-alive sockets close, the pool and Redis
 * disconnect. If that takes longer than SHUTDOWN_TIMEOUT_MS the process exits
 * with status 1.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const logger = createLogger(config);
  const app = await buildApp(config, { logger });

  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error({ timeoutMs: config.shutdown.timeoutMs }, 'shutdown timed out; exiting');
      process.exit(1);
    }, config.shutdown.timeoutMs);
    app.readiness.beginShutdown();
    if (config.shutdown.drainMs > 0) await sleep(config.shutdown.drainMs);
    try {
      await app.close();
      logger.info('stopped');
      process.exitCode = 0;
    } catch (error) {
      logger.error({ err: error }, 'error while closing');
      process.exitCode = 1;
    } finally {
      clearTimeout(force);
      // Exit even if a stray handle would keep the event loop alive.
      setTimeout(() => process.exit(), 1_000).unref();
    }
  };
  process.once('SIGTERM', (signal) => void stop(signal));
  process.once('SIGINT', (signal) => void stop(signal));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  console.error('api failed to start', error);
  process.exit(1);
});
