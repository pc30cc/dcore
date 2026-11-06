import type { APIRoute } from 'astro';
import { assetLinks } from '../../lib/assetLinks';
import { brandConfig } from '../../lib/brand';

/** Digital Asset Links for both store packages (an empty list until their fingerprints are in brand.json). */
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(assetLinks(brandConfig), null, 2)}\n`, {
    headers: { 'content-type': 'application/json' },
  });
