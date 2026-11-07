import type { FastifyPluginAsync } from 'fastify';
import { configRoutes } from './config.js';
import { deviceRoutes } from './devices.js';
import { locationRoutes } from './location.js';
import { meRoutes } from './me.js';
import { moderationRoutes } from './moderation.js';
import { realtimeRoutes } from './realtime.js';

/** The configuration, own-account, location, device, realtime-token and moderation routes. */
export const accountRoutes: FastifyPluginAsync = async (app) => {
  await app.register(configRoutes);
  await app.register(meRoutes);
  await app.register(locationRoutes);
  await app.register(deviceRoutes);
  await app.register(realtimeRoutes);
  await app.register(moderationRoutes);
};
