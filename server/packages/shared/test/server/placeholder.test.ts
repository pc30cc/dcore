import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_TONES, blurhashAverage, likePlaceholder } from '../../src/server/index.js';

describe('the placeholder of a closed like', () => {
  const hashes = ['LKO2?U%2Tw=w]~RBVZRi};RPxuwH', 'L6PZfSi_.AyE_3t7t7R**0o#DgR4', 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 'LGF5]+Yk^6#M@-5c,1J5@[or[Q6.'];

  it('is a one-colour hash from a few tones, never the photo\'s own blurhash', () => {
    const tones = new Set(PLACEHOLDER_TONES.map(([r, g, b]) => (r << 16) | (g << 8) | b));
    for (const hash of hashes) {
      const placeholder = likePlaceholder(hash);
      expect(placeholder).toHaveLength(6);
      expect(placeholder).not.toBe(hash);
      expect(placeholder.startsWith('00')).toBe(true);
      const [r, g, b] = blurhashAverage(placeholder)!;
      expect(tones.has((r << 16) | (g << 8) | b)).toBe(true);
    }
    // Several photos share a tone: the placeholder does not single a person out.
    expect(new Set(hashes.map(likePlaceholder)).size).toBeLessThan(hashes.length);
  });

  it('follows the photo\'s average colour, and falls back to the middle tone', () => {
    expect(blurhashAverage('LKO2?U%2Tw=w]~RBVZRi};RPxuwH')).not.toBeNull();
    expect(blurhashAverage('nope')).toBeNull();
    expect(blurhashAverage('LKO2?U%2Tw=w]~RBVZRi};RPxuw')).toBeNull();
    const middle = likePlaceholder(undefined);
    expect(likePlaceholder('not a hash')).toBe(middle);
    expect(likePlaceholder(null)).toBe(middle);
  });
});
