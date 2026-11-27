import type { FastifyPluginAsync } from 'fastify';

/**
 * The app area of the admin API. The area's route files register inside
 * this plugin (`await app.register(...)`), so `app.ts` holds one line per
 * area and the area's routes stay together.
 */
export const appAreaRoutes: FastifyPluginAsync = async (_app) => {
  // app
};
