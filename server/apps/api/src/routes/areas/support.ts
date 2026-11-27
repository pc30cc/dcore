import type { FastifyPluginAsync } from 'fastify';

/**
 * The support area of the admin API. The area's route files register inside
 * this plugin (`await app.register(...)`), so `app.ts` holds one line per
 * area and the area's routes stay together.
 */
export const supportAreaRoutes: FastifyPluginAsync = async (_app) => {
  // support
};
