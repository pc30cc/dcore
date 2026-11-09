import type { WorkerConfig } from '../config.js';
import type { JobContext } from '../queues/types.js';
import type { WorkerServices } from '../services.js';
import { publishOrigins, type PublishOutcome } from './publish.js';
import { mediaTarget, targetOf, type PublishTarget } from './targets.js';

/** How often the worker looks for a newer origins document (one Valkey read when there is none). */
export const ORIGINS_PUBLISH_EVERY_MS = 10 * 60_000;

const built = new WeakMap<WorkerServices, PublishTarget[]>();

/** The targets of this process: the media bucket (when storage is configured and ORIGINS_PUBLISH_MEDIA is on), then ORIGINS_PUBLISH_TARGETS. */
export function publishTargets(config: WorkerConfig, services: WorkerServices): PublishTarget[] {
  let targets = built.get(services);
  if (!targets) {
    targets = [...(config.origins.media && services.media ? [mediaTarget(services.media)] : []), ...config.origins.targets.map((target) => targetOf(target))];
    built.set(services, targets);
  }
  return targets;
}

/** The `origins-publish` job of the system queue; `data.version` (after a save) waits for the API to have signed it. */
export async function runOriginsPublish(data: unknown, context: JobContext): Promise<PublishOutcome> {
  const version = typeof data === 'object' && data !== null && Number.isSafeInteger((data as { version?: unknown }).version) ? Number((data as { version: number }).version) : undefined;
  const outcome = await publishOrigins(
    { redis: context.redis, keys: context.services.keys, targets: publishTargets(context.config, context.services), log: context.log },
    version,
  );
  if (outcome.failed.length > 0) {
    // A failed run is kept with its reason; the next round retries the targets that failed.
    throw new Error(`origins: not published to ${outcome.failed.join(', ')}`);
  }
  return outcome;
}
