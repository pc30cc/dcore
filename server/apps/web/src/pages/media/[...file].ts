import type { APIRoute, GetStaticPaths } from 'astro';
import { brandConfig } from '../../lib/brand';
import { readMedia } from '../../lib/media';

/** The brand's images the pages show (brand.json `site.screenshots`), copied from the brand folder. */
export const getStaticPaths = (() =>
  (brandConfig.site?.screenshots ?? []).map((shot) => ({ params: { file: shot.file } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ params }) => {
  const media = readMedia(params['file'] ?? '');
  return new Response(media.bytes, { headers: { 'content-type': media.type } });
};
