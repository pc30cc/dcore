import type { FastifyPluginAsync } from 'fastify';
import { adminStatsRoutes } from '../adminStats.js';

/**
 * The dashboard area of the admin API. The area's route files register inside
 * this plugin (`await app.register(...)`), so `app.ts` holds one line per
 * area and the area's routes stay together.
 */
export const dashboardAreaRoutes: FastifyPluginAsync = async (app) => {
  // dashboard
  await app.register(adminStatsRoutes);
};
