/**
 * The placeholder a closed like shows (a free plan sees who liked them only
 * blurred): never the liker's own blurhash. Cards carry that blurhash, so a
 * client comparing it with the cards of its deck would name every liker.
 *
 * The placeholder is a one-colour BlurHash (1 × 1 components, six
 * characters, which every decoder renders as a flat tone) whose colour is
 * the nearest of a few soft tones to the photo's average colour. Many
 * people share each tone, no card carries a hash of that size, and the
 * tone says little more than "light", "dark" or "warm" about the photo.
 */

const BASE83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

/** The tones a placeholder may take (sRGB). */
export const PLACEHOLDER_TONES: readonly (readonly [number, number, number])[] = [
  [0x3a, 0x3a, 0x40], // dark
  [0x8a, 0x86, 0x84], // grey
  [0xd4, 0xd0, 0xcc], // light
  [0xb8, 0x8c, 0x74], // warm
  [0x6c, 0x5a, 0x4e], // brown
  [0x74, 0x84, 0x98], // cool
];

function decode83(text: string): number | null {
  let value = 0;
  for (const char of text) {
    const digit = BASE83.indexOf(char);
    if (digit < 0) return null;
    value = value * 83 + digit;
  }
  return value;
}

function encode83(value: number, length: number): string {
  let out = '';
  for (let i = 1; i <= length; i += 1) out += BASE83[Math.floor(value / 83 ** (length - i)) % 83];
  return out;
}

/** A photo's average colour (its BlurHash DC term), or null when the hash is not a BlurHash. */
export function blurhashAverage(hash: string): readonly [number, number, number] | null {
  if (hash.length < 6) return null;
  const size = decode83(hash[0]!);
  if (size === null) return null;
  const components = (Math.floor(size / 9) + 1) * ((size % 9) + 1);
  if (hash.length !== 4 + 2 * components) return null;
  const dc = decode83(hash.slice(2, 6));
  if (dc === null) return null;
  return [dc >> 16, (dc >> 8) & 255, dc & 255];
}

/** The placeholder of a closed like for a photo's blurhash (a fixed middle tone when the hash is unreadable). */
export function likePlaceholder(hash: string | null | undefined): string {
  const average = hash ? blurhashAverage(hash) : null;
  let best = PLACEHOLDER_TONES[1]!;
  if (average) {
    let distance = Number.POSITIVE_INFINITY;
    for (const tone of PLACEHOLDER_TONES) {
      const d = (tone[0] - average[0]) ** 2 + (tone[1] - average[1]) ** 2 + (tone[2] - average[2]) ** 2;
      if (d < distance) {
        distance = d;
        best = tone;
      }
    }
  }
  // Size flag 0 (1 × 1), maximum AC 0 (there is none), then the colour.
  return `00${encode83((best[0] << 16) | (best[1] << 8) | best[2], 4)}`;
}
