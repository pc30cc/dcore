import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/** The repository's deploy folder, and its Coolify compose file read as data. */
export const DEPLOY = fileURLToPath(new URL('../../../../deploy', import.meta.url));

interface ComposeService {
  environment?: string[];
  ports?: string[];
}

export function composeServices(): Record<string, ComposeService> {
  const compose = parse(readFileSync(join(DEPLOY, 'coolify/docker-compose.yml'), 'utf8')) as { services: Record<string, ComposeService> };
  return compose.services;
}

/** A service's environment as name → value (a bare name has itself as value). */
export function composeEnv(service: string): Record<string, string> {
  const entries = (composeServices()[service]?.environment ?? []).map((line): [string, string] => {
    const at = line.indexOf('=');
    return at < 0 ? [line, line] : [line.slice(0, at), line.slice(at + 1)];
  });
  return Object.fromEntries(entries);
}
