import pino, { type Logger } from 'pino';
import type { WorkerConfig } from './config.js';

export function createLogger(config: WorkerConfig): Logger {
  return pino({
    level: config.log.level,
    base: { service: 'worker', workerId: config.workerId },
    ...(config.log.pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  });
}
