import { ConfigError } from '@app/config';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startWorker } from './worker.js';

/**
 * The worker process. On SIGTERM/SIGINT it stops taking jobs, lets running
 * ones finish (up to SHUTDOWN_TIMEOUT_MS) and exits.
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
  const runtime = await startWorker(config, { logger });

  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error({ timeoutMs: config.shutdownTimeoutMs }, 'shutdown timed out; exiting');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    try {
      await runtime.stop();
      process.exitCode = 0;
    } catch (error) {
      logger.error({ err: error }, 'error while stopping');
      process.exitCode = 1;
    } finally {
      clearTimeout(force);
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
}

main().catch((error: unknown) => {
  console.error('worker failed to start', error);
  process.exit(1);
});
