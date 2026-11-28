import { describe, expect, it } from 'vitest';
import { secretFingerprint, turnSecretFingerprint } from '../../src/server/index.js';

describe('the admin panel fingerprint of a secret', () => {
  it('is the first 12 hex digits of its SHA-256, as sha256sum prints them', () => {
    // printf %s abc | sha256sum
    expect(secretFingerprint('abc')).toBe('ba7816bf8f01');
    expect(turnSecretFingerprint('abc')).toBe(secretFingerprint('abc'));
  });
});
