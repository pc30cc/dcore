import type { FastifyPluginAsync } from 'fastify';
import { adminGrantRoutes } from '../adminGrants.js';
import { adminPurchaseRoutes } from '../adminPurchases.js';

/**
 * The revenue area of the admin API. The area's route files register inside
 * this plugin (`await app.register(...)`), so `app.ts` holds one line per
 * area and the area's routes stay together.
 */
export const revenueAreaRoutes: FastifyPluginAsync = async (app) => {
  // revenue
  await app.register(adminPurchaseRoutes);
  await app.register(adminGrantRoutes);
};
