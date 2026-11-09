import { ConfigError } from '@app/config';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startWorker } from './worker.js';
import { takeWorkerSlot, type HeldWorkerSlot } from './workerSlot.js';

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
  // Without WORKER_ID the process is named after a leased slot (w0, w1, ...): see workerSlot.ts.
  let slot: HeldWorkerSlot | null = null;
  let logger = createLogger(config);
  if (config.workerIdSource === 'lease') {
    const slotLog = (): typeof logger => logger;
    slot = await takeWorkerSlot(
      config,
      {
        onLost: () => {
          // Two processes must not run under one name: exit, and start again with a free slot.
          slotLog().fatal("worker slot: another process holds this worker's name now; exiting");
          process.exit(1);
        },
        onExpired: () => slotLog().error('worker slot: not refreshed for a whole lease; another worker may take the name meanwhile'),
        onRefreshFailed: (error) => slotLog().warn({ err: error }, 'worker slot: refresh failed'),
      },
      { onWait: (error) => slotLog().warn({ err: error }, 'worker slot: none taken yet; retrying') },
    );
    config = slot.config;
    logger = createLogger(config);
  }
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
      await slot?.release();
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
