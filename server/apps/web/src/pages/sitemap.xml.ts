import type { APIRoute } from 'astro';
import { siteOrigin } from '../lib/brand';
import { allPaths } from '../lib/routes';

export const GET: APIRoute = () => {
  const urls = allPaths()
    .map((path) => `  <url><loc>${siteOrigin}${path}</loc></url>`)
    .join('\n');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
};
