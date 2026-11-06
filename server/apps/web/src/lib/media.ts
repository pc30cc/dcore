import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Locale } from '@app/shared';
import { brandConfig, brandCopy, brandDir } from './brand';
import { imageSize } from './imageSize';

const mimeTypes: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export interface MediaFile {
  /** The brand-relative file name, also the path under `/media/`. */
  file: string;
  bytes: Uint8Array<ArrayBuffer>;
  type: string;
  width: number;
  height: number;
}

/** Reads a file of the brand folder; a missing or unreadable image fails the build. */
export function readMedia(file: string): MediaFile {
  const absolute = path.resolve(brandDir, file);
  const relative = path.relative(brandDir, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`brand image outside the brand folder: ${file}`);
  const type = mimeTypes[path.extname(file).toLowerCase()];
  if (type === undefined) throw new Error(`brand image of an unknown type: ${file}`);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(readFileSync(absolute));
  } catch (error) {
    throw new Error(`brand image not found: ${absolute}`, { cause: error });
  }
  const size = imageSize(bytes);
  if (size === undefined) throw new Error(`brand image is not a readable ${type} file: ${absolute}`);
  return { file, bytes, type, ...size };
}

export interface Screenshot {
  src: string;
  alt: string;
  width: number;
  height: number;
}

export function mediaPath(file: string): string {
  return `/media/${file}`;
}

/** The home page's screenshots (brand.json `site.screenshots`), with their size and text in `locale`. */
export function screenshots(locale: Locale): Screenshot[] {
  return (brandConfig.site?.screenshots ?? []).map((shot) => {
    const media = readMedia(shot.file);
    return { src: mediaPath(shot.file), alt: brandCopy(shot.alt, locale), width: media.width, height: media.height };
  });
}
