import { writeHomeLocation } from '@app/db';
import { citiesQuerySchema, cityListSchema, locationResultSchema, locationSource, locationUpdateSchema } from '@app/shared';
import { cellCentre, homeCell } from '@app/shared/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { scrubbed } from '../lib/dbErrors.js';
import { HttpProblem } from '../lib/problem.js';
import { CITY_RADIUS_KM, COUNTRY_RADIUS_KM, type CityRecord } from '../services/cities.js';
import { requireScope, sessionOf } from '../services/session.js';

/**
 * `PUT /v1/me/location` and `GET /v1/cities`.
 *
 * The position becomes its H3 r7 cell in memory; only the cell and the
 * cell's centre are kept, and the city and country are looked up for the
 * centre (never for the position). Nothing here logs the body. `loc:<uid>`
 * holds what was last written (cell, source, city, country): a report from
 * the same cell costs no statement and counts against no limit; a new cell
 * is one statement, at most one a minute.
 */

/** What was last written for the account, so an unchanged cell writes nothing. */
const LOCATION_TTL_SECONDS = 30 * 24 * 3_600;
export const LOCATION_CHANGE_SECONDS = 60;

export const locationRoutes: FastifyPluginAsyncZod = async (app) => {
  const fullOnly = requireScope(app, app.account, ['full']);

  app.put(
    '/v1/me/location',
    {
      preHandler: fullOnly,
      config: { pgBudget: 1 },
      schema: { tags: ['me'], summary: 'Report the home location (kept as a coarse cell)', body: locationUpdateSchema, response: { 200: locationResultSchema } },
    },
    async (request) => {
      const session = sessionOf(app, request);
      const body = request.body;
      const cities = app.cities;

      let position: { lat: number; lng: number };
      let city: CityRecord | undefined;
      let country: string;
      if (body.source === 'city') {
        city = body.cityId === undefined ? undefined : cities.get(body.cityId);
        if (!city) throw new HttpProblem('field_invalid', { detail: 'Unknown city.', errors: [{ in: 'body', pointer: '/cityId', code: 'unknown', message: 'Unknown city.' }] });
        position = { lat: city.lat, lng: city.lng };
        country = city.country;
      } else {
        position = { lat: body.lat!, lng: body.lng! };
      }
      const cell = homeCell(position);
      const centre = cellCentre(cell);
      if (body.source !== 'city') {
        const nearest = cities.nearest(centre, COUNTRY_RADIUS_KM);
        if (!nearest) throw new HttpProblem('field_invalid', { detail: 'This place is not served.' });
        country = nearest.city.country;
        if (nearest.km <= CITY_RADIUS_KM) city = nearest.city;
      } else {
        country = (city!).country;
      }
      const cityId = city?.id;
      const result = { ...(city ? { city: { id: city.id, name: cities.nameOf(city, request.locale) } } : {}), country };
      const source = locationSource.code(body.source);
      const stamp = `${cell}:${source}:${cityId ?? ''}:${country}`;
      const key = app.keys.location(session.userId);

      let known: string | null = null;
      try {
        known = await app.redis.get(key);
      } catch (error) {
        request.log.warn({ err: error }, 'location: last cell unreadable');
      }
      if (known === stamp) return result;

      try {
        const allowed = await app.redis.set(app.keys.raw('rl', 'loc', session.userId), '1', 'EX', LOCATION_CHANGE_SECONDS, 'NX');
        if (allowed === null) {
          const ttl = await app.redis.ttl(app.keys.raw('rl', 'loc', session.userId));
          throw new HttpProblem('rate_limited', { detail: 'The location changes at most once a minute.', retryAfterSeconds: Math.max(1, ttl) });
        }
      } catch (error) {
        if (error instanceof HttpProblem) throw error;
        request.log.warn({ err: error }, 'location: change limiter unavailable');
      }

      await scrubbed(() => writeHomeLocation(app.pg, session.userId, { cell, centre, cityId: cityId ?? null, source, country }));
      await app.redis.set(key, stamp, 'EX', LOCATION_TTL_SECONDS).catch((error: unknown) => request.log.warn({ err: error }, 'location: last cell not cached'));
      await app.account.changed(session.userId);
      return result;
    },
  );

  app.get(
    '/v1/cities',
    {
      preHandler: fullOnly,
      config: { pgBudget: 0 },
      schema: { tags: ['me'], summary: 'Search the city table', querystring: citiesQuerySchema, response: { 200: cityListSchema } },
    },
    async (request) => {
      const { q, country } = request.query;
      return { items: app.cities.search(q, request.locale, country) };
    },
  );
};
