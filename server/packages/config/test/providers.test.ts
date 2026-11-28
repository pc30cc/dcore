import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { DataSealer } from '@app/shared/server';
import { describe, expect, it } from 'vitest';
import {
  ProviderSettingsError,
  effectiveProviders,
  mergeProviderUpdate,
  openStoredProvider,
  providerConfigOf,
  providerFingerprint,
  providersHash,
  secretFieldFingerprint,
} from '../src/providers.js';

const sealer = new DataSealer(new Map([[1, randomBytes(32)]]), 1);
const sha12 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

function account(): { json: string; privateKey: string } {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { json: JSON.stringify({ client_email: 'sa@demo.iam.gserviceaccount.com', private_key: privateKey, project_id: 'demo-project' }), privateKey };
}

const kavenegar = (apiKey: string, enabled = true) => mergeProviderUpdate('kavenegar', null, { enabled, settings: { template: 'otp' }, secrets: { apiKey } }, sealer).value;

describe('provider entries from the admin panel', () => {
  it('wins over the environment per kind, and turns the provider off when off or unreadable', () => {
    const env = { kavenegar: { apiKey: 'env-key-1234', template: 'env' }, smsir: { apiKey: 'env-smsir-1234', templateId: 1, parameter: 'CODE' } };
    const none = effectiveProviders(env, {}, sealer);
    expect(none.sources).toMatchObject({ kavenegar: 'env', smsir: 'env', telnyx: 'none', play: 'none', fcm: 'none' });
    expect(none.fingerprints.kavenegar).toBe(sha12('env-key-1234'));
    const stored = { 'providers.kavenegar': kavenegar('panel-key-1234'), 'providers.smsir': mergeProviderUpdate('smsir', null, { enabled: false, settings: { templateId: 2, parameter: 'CODE' }, secrets: { apiKey: 'x-key-12345678' } }, sealer).value };
    const eff = effectiveProviders(env, stored, sealer);
    expect(eff.sources.kavenegar).toBe('panel');
    expect(eff.configs.kavenegar).toEqual({ apiKey: 'panel-key-1234', template: 'otp' });
    expect(eff.fingerprints.kavenegar).toBe(sha12('panel-key-1234'));
    expect(eff.sources.smsir).toBe('off');
    expect(eff.configs.smsir).toBeUndefined();
    // Another deployment's keys, or no keys at all: unreadable, never the environment's.
    const other = new DataSealer(new Map([[1, randomBytes(32)]]), 1);
    expect(effectiveProviders(env, stored, other).sources.kavenegar).toBe('unreadable');
    expect(effectiveProviders(env, stored, null).sources.kavenegar).toBe('unreadable');
  });

  it('seals per kind: a blob copied to another kind does not open', () => {
    const value = kavenegar('copied-key-1234');
    expect(openStoredProvider('telnyx', value, sealer)).toBe('unreadable');
    expect(openStoredProvider('kavenegar', value, sealer)).toMatchObject({ enabled: true, secrets: { apiKey: 'copied-key-1234' } });
    expect(JSON.stringify(value)).not.toContain('copied-key-1234');
  });

  it('fingerprints a service account by its private key, like an environment value', () => {
    const sa = account();
    expect(secretFieldFingerprint('serviceAccountJson', sa.json)).toBe(sha12(sa.privateKey));
    expect(secretFieldFingerprint('serviceAccountJson', Buffer.from(sa.json).toString('base64'))).toBe(sha12(sa.privateKey));
    expect(providerFingerprint('abc')).toBe(sha12('abc'));
    const play = mergeProviderUpdate('play', null, { enabled: true, settings: { packageName: 'com.example.app', rtdnAudience: null, rtdnPushServiceAccountEmail: null }, secrets: { serviceAccountJson: sa.json } }, sealer);
    expect(play.after.secrets['serviceAccountJson']).toBe(sha12(sa.privateKey));
    expect(effectiveProviders({}, { 'providers.play': play.value }, sealer).fingerprints.play).toBe(sha12(sa.privateKey));
  });

  it('merges a write: sent secrets replace, the rest are kept, the other Bazaar access kind is dropped', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const oauth = { packageName: 'com.example.app', rsaPublicKey: rsa, auth: 'oauth', clientId: 'client-1' };
    const first = mergeProviderUpdate('bazaar', null, { enabled: true, settings: oauth, secrets: { clientSecret: 'secret-1234', refreshToken: 'refresh-1234' } }, sealer);
    const second = mergeProviderUpdate('bazaar', first.value, { enabled: true, settings: oauth, secrets: { refreshToken: 'refresh-5678' } }, sealer);
    expect(second.changed).toEqual(['secrets.refreshToken']);
    expect(second.after.secrets).toEqual({ clientSecret: sha12('secret-1234'), refreshToken: sha12('refresh-5678') });
    const same = mergeProviderUpdate('bazaar', second.value, { enabled: true, settings: oauth }, sealer);
    expect(same.changed).toEqual([]);
    expect(() => mergeProviderUpdate('bazaar', second.value, { enabled: true, settings: { ...oauth, auth: 'pishkhan', clientId: null } }, sealer)).toThrow(ProviderSettingsError);
    const pishkhan = mergeProviderUpdate('bazaar', second.value, { enabled: true, settings: { ...oauth, auth: 'pishkhan', clientId: null }, secrets: { pishkhanToken: 'pishkhan-1234' } }, sealer);
    expect(Object.keys(pishkhan.after.secrets)).toEqual(['pishkhanToken']);
  });

  it('names the field of a refusal and never the value', () => {
    try {
      mergeProviderUpdate('fcm', null, { enabled: true, settings: { projectId: null }, secrets: { serviceAccountJson: 'not json at all, secret-ish' } }, sealer);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderSettingsError);
      expect((error as ProviderSettingsError).pointer).toBe('/secrets/serviceAccountJson');
      expect((error as ProviderSettingsError).code).toBe('credentials_invalid');
      expect((error as Error).message).not.toContain('secret-ish');
    }
    expect(() => mergeProviderUpdate('telnyx', null, { enabled: true, settings: { verifyProfileId: 'profile-1' } }, sealer)).toThrow(/apiKey/);
  });

  it('takes a panel Play account only with Google\'s own token endpoint', () => {
    const sa = account();
    const parsed = JSON.parse(sa.json) as Record<string, unknown>;
    const play = (json: string) =>
      providerConfigOf('play', { packageName: 'com.example.app', rtdnAudience: null, rtdnPushServiceAccountEmail: null }, { serviceAccountJson: json });
    expect(play(sa.json).serviceAccount.tokenUri).toBe('https://oauth2.googleapis.com/token');
    expect(play(JSON.stringify({ ...parsed, token_uri: 'https://oauth2.googleapis.com/token' })).serviceAccount.tokenUri).toBe('https://oauth2.googleapis.com/token');
    for (const tokenUri of ['https://10.0.0.5/internal', 'https://collector.example/token', 'https://oauth2.googleapis.com.example/token']) {
      try {
        play(JSON.stringify({ ...parsed, token_uri: tokenUri }));
        expect.unreachable(tokenUri);
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderSettingsError);
        expect((error as ProviderSettingsError).pointer).toBe('/secrets/serviceAccountJson');
        expect((error as ProviderSettingsError).code).toBe('credentials_invalid');
      }
    }
    // A stored entry with such an account (sealed by hand) is not used either: the store is off.
    const sealed = sealer.seal(JSON.stringify({ serviceAccountJson: JSON.stringify({ ...parsed, token_uri: 'https://10.0.0.5/internal' }) }), 'providers.play.secrets').toString('base64');
    const stored = { v: 1, enabled: true, settings: { packageName: 'com.example.app', rtdnAudience: null, rtdnPushServiceAccountEmail: null }, secrets: sealed };
    const eff = effectiveProviders({}, { 'providers.play': stored }, sealer);
    expect(eff.sources.play).toBe('unreadable');
    expect(eff.configs.play).toBeUndefined();
  });

  it('hashes only the provider rows', () => {
    const a = providersHash({ 'providers.kavenegar': { enabled: true } });
    expect(providersHash({ 'providers.kavenegar': { enabled: true }, 'other.key': 1 })).toBe(a);
    expect(providersHash({ 'providers.kavenegar': { enabled: false } })).not.toBe(a);
  });
});
