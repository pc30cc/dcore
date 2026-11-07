/**
 * Builds the bundled city table (`data/cities.json.gz`) from GeoNames dumps
 * (https://download.geonames.org/export/dump/, CC BY 4.0):
 *
 *   cities15000.txt       every place with 15,000+ people, worldwide
 *   cities5000.txt        5,000+ people, used for the countries in --dense
 *   alternateNamesV2.txt  names per language (fa, tr, en are kept)
 *
 *   pnpm --filter @app/api exec tsx --conditions=@app/source src/scripts/build-cities.ts \
 *     --dir /path/to/dumps [--dense IR,TR] [--out data/cities.json.gz]
 *
 * The output is a gzipped JSON document `{ source, built, columns, rows }`
 * where each row is `[id, lat, lng, country, population, name, fa, tr, en]`
 * (coordinates rounded to 4 decimals, names absent as empty strings). The
 * API reads it once at start-up (services/cities.ts).
 */
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';

interface Args {
  dir: string;
  dense: Set<string>;
  out: string;
}

function parseArgs(argv: string[]): Args {
  let dir = '';
  let dense = 'IR,TR';
  let out = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../data/cities.json.gz');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1] ?? '';
    if (arg === '--dir') dir = value;
    else if (arg === '--dense') dense = value;
    else if (arg === '--out') out = path.resolve(value);
    else continue;
    i += 1;
  }
  if (!dir) throw new Error('--dir <folder with the GeoNames dumps> is required');
  return { dir, dense: new Set(dense.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)), out };
}

/** Feature codes of places people live in now (no neighbourhoods, ruins or historical places). */
const KEPT = new Set(['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5', 'PPLC', 'PPLG', 'PPLL', 'PPLS', 'PPLF', 'PPLR']);

interface City {
  id: number;
  lat: number;
  lng: number;
  country: string;
  population: number;
  name: string;
}

function readCities(file: string, only?: Set<string>): City[] {
  const out: City[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const c = line.split('\t');
    const [id, name, , , lat, lng, , code, country, , , , , , population] = c;
    if (!id || !name || !code || !country || !KEPT.has(code)) continue;
    if (only && !only.has(country)) continue;
    out.push({ id: Number(id), lat: Number(lat), lng: Number(lng), country, population: Number(population) || 0, name });
  }
  return out;
}

const LANGUAGES = ['fa', 'tr', 'en'] as const;
type Language = (typeof LANGUAGES)[number];

interface Candidate {
  name: string;
  rank: number;
}

async function readNames(file: string, ids: Set<number>): Promise<Map<number, Partial<Record<Language, string>>>> {
  const best = new Map<number, Partial<Record<Language, Candidate>>>();
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    // alternateNameId, geonameid, isolanguage, name, isPreferred, isShort, isColloquial, isHistoric, from, to
    const c = line.split('\t');
    const id = Number(c[1]);
    const language = c[2] as Language;
    const name = c[3];
    if (!ids.has(id) || !LANGUAGES.includes(language) || !name) continue;
    if (c[6] === '1' || c[7] === '1' || (c[9] ?? '') !== '') continue;
    // Preferred names first, then full (not short) names, then the first seen.
    const rank = (c[4] === '1' ? 0 : 2) + (c[5] === '1' ? 1 : 0);
    const entry = best.get(id) ?? {};
    const current = entry[language];
    if (current === undefined || rank < current.rank) entry[language] = { name, rank };
    best.set(id, entry);
  }
  const out = new Map<number, Partial<Record<Language, string>>>();
  for (const [id, entry] of best) {
    out.set(id, Object.fromEntries(Object.entries(entry).map(([language, candidate]) => [language, candidate.name])));
  }
  return out;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const byId = new Map<number, City>();
  for (const city of readCities(path.join(args.dir, 'cities15000.txt'))) byId.set(city.id, city);
  for (const city of readCities(path.join(args.dir, 'cities5000.txt'), args.dense)) byId.set(city.id, city);
  const names = await readNames(path.join(args.dir, 'alternateNamesV2.txt'), new Set(byId.keys()));
  const cities = [...byId.values()].sort((a, b) => b.population - a.population || a.id - b.id);
  const rows = cities.map((city) => {
    const own = names.get(city.id) ?? {};
    return [city.id, round4(city.lat), round4(city.lng), city.country, city.population, city.name, own.fa ?? '', own.tr ?? '', own.en ?? ''];
  });
  const document = {
    source: 'GeoNames (geonames.org), CC BY 4.0',
    built: new Date().toISOString().slice(0, 10),
    columns: ['id', 'lat', 'lng', 'country', 'population', 'name', 'fa', 'tr', 'en'],
    rows,
  };
  writeFileSync(args.out, gzipSync(Buffer.from(JSON.stringify(document)), { level: 9 }));
  process.stdout.write(`${rows.length} cities written to ${args.out}\n`);
}

await main();
