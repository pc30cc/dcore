import type { FastifyPluginAsync } from 'fastify';
import { adminRoleRoutes } from '../adminRoles.js';
import { adminSystemRoutes, type AdminSystemRoutesOptions } from '../adminSystem.js';

/**
 * The system area of the admin API. The area's route files register inside
 * this plugin (`await app.register(...)`), so `app.ts` holds one line per
 * area and the area's routes stay together.
 */
export const systemAreaRoutes: FastifyPluginAsync<AdminSystemRoutesOptions> = async (app, options) => {
  // system
  await app.register(adminSystemRoutes, options);
  await app.register(adminRoleRoutes);
};
