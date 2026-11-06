import type { APIRoute } from 'astro';
import { securityTxt } from '../../lib/securityTxt';

export const GET: APIRoute = () =>
  new Response(securityTxt(new Date()), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
