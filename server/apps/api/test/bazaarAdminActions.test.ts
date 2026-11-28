import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BAZAAR_ADMIN_ACTIONS, BazaarVerifier, createKeys } from '@app/shared/server';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { envVariables } from '../src/config.js';
import { bazaarVerifierFactory } from '../src/services/billing/bazaar/index.js';
import { DEPLOY, composeEnv } from './deploySupport.js';
import { testConfig } from './support.js';

/**
 * BAZAAR_ADMIN_ACTIONS: the panel's Cafe Bazaar refund and stop of renewal
 * are offered only once the server's own setting lists them (their request
 * shapes are confirmed on a sandbox first); the default offers neither, and
 * nothing beyond the documented pair can be turned on. The deploy file
 * hands the setting to the api container (compose passes a container only
 * the variables its service lists).
 */

const PACKAGE = 'com.example.app';
const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const bazaarEnv = { BAZAAR_PACKAGE_NAME: PACKAGE, BAZAAR_RSA_PUBLIC_KEY: publicKey, BAZAAR_PISHKHAN_API_TOKEN: 'pishkhan-test-token' };
const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;
// The call meter only keeps the client until a call is made; none is made here.
const deps = { redis: {} as Redis, keys: createKeys('t:') };

function verifierWith(env: Record<string, string>): BazaarVerifier {
  const verifier = bazaarVerifierFactory(testConfig({ ...bazaarEnv, ...env }), log, deps);
  if (!(verifier instanceof BazaarVerifier)) throw new Error('no Bazaar verifier');
  return verifier;
}

describe('Cafe Bazaar admin actions (BAZAAR_ADMIN_ACTIONS)', () => {
  it('offers nothing by default', () => {
    expect(testConfig(bazaarEnv).bazaarAdminActions).toEqual(BAZAAR_ADMIN_ACTIONS);
    expect(verifierWith({}).adminActions).toEqual({ subscription: [], consumable: [] });
  });

  it('offers a pack’s refund and a subscription’s stop of renewal when listed', () => {
    expect(verifierWith({ BAZAAR_ADMIN_ACTIONS: 'refund' }).adminActions).toEqual({ subscription: [], consumable: ['refund'] });
    expect(verifierWith({ BAZAAR_ADMIN_ACTIONS: 'cancel' }).adminActions).toEqual({ subscription: ['cancel'], consumable: [] });
    expect(verifierWith({ BAZAAR_ADMIN_ACTIONS: ' refund , cancel ' }).adminActions).toEqual({ subscription: ['cancel'], consumable: ['refund'] });
  });

  it('refuses any other value at start, naming the variable', () => {
    expect(() => testConfig({ ...bazaarEnv, BAZAAR_ADMIN_ACTIONS: 'refund,refund_prorated' })).toThrow(/BAZAAR_ADMIN_ACTIONS/);
  });

  it('reaches the deployed api like every store variable it reads, empty unless the stack sets it', () => {
    const api = composeEnv('api');
    const store = envVariables.filter((name) => /^(PLAY|BAZAAR)_/.test(name));
    expect(store).toContain('BAZAAR_ADMIN_ACTIONS');
    expect(store.filter((name) => !(name in api))).toEqual([]);
    expect(api['BAZAAR_ADMIN_ACTIONS']).toBe('${BAZAAR_ADMIN_ACTIONS:-}');
    expect(readFileSync(join(DEPLOY, 'coolify/.env.example'), 'utf8')).toMatch(/^BAZAAR_ADMIN_ACTIONS=$/m);
  });
});
