import type { FastifyPluginAsync } from 'fastify';
import { adminBrandRoutes } from '../adminBrand.js';
import { adminConfigRoutes } from '../adminConfig.js';
import { adminProfileReviewRoutes } from '../adminProfileReviews.js';
import { adminProviderRoutes } from '../adminProviders.js';

/**
 * The app area of the admin API. The area's route files register inside
 * this plugin (`await app.register(...)`), so `app.ts` holds one line per
 * area and the area's routes stay together.
 */
export const appAreaRoutes: FastifyPluginAsync = async (app) => {
  // app
  await app.register(adminConfigRoutes);
  await app.register(adminBrandRoutes);
  await app.register(adminProviderRoutes);
  await app.register(adminProfileReviewRoutes);
};
