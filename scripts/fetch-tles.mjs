#!/usr/bin/env node
// STAR · refresh the bundled Starlink constellation from CelesTrak (public orbital data).
//   node scripts/fetch-tles.mjs
// Writes assets/data/starlink.tle (3-line TLE, as served) + assets/data/starlink.meta.json.
// CelesTrak only updates GP data every ~2h and returns HTTP 403 if you re-download the same
// GROUP+FORMAT before it changes — that is expected, the existing file is kept.
// Not affiliated with SpaceX / Starlink. Data: CelesTrak (celestrak.org), public GP elements.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, parseTLE } from './star-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets/data/starlink.tle');
const META = join(ROOT, 'assets/data/starlink.meta.json');
const SOURCES = [
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=3le',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle',
];

let text = null, src = null;
for (const url of SOURCES) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'star-site-refresh/1.0' } });
    const t = await r.text();
    if (!r.ok) { console.warn(`[tle] ${r.status} from ${url}: ${t.trim().slice(0, 160)}`); continue; }
    const n = parseTLE(t).length;
    if (n < 1000) { console.warn(`[tle] only ${n} sats from ${url}, skipping`); continue; }
    text = t; src = url; break;
  } catch (e) { console.warn(`[tle] ${url} failed: ${e.message}`); }
}
if (!text) {
  console.error(existsSync(OUT) ? '[tle] no fresh data — keeping existing bundled file.' : '[tle] no data and no bundled file!');
  process.exit(existsSync(OUT) ? 0 : 1);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, text);
const sats = parseTLE(text);
const epochs = sats.map((s) => s.epochMs).sort((a, b) => a - b);
const meta = {
  source: src,
  fetched_at: new Date().toISOString(),
  count: sats.length,
  epoch_newest: new Date(epochs.at(-1)).toISOString(),
  epoch_median: new Date(epochs[epochs.length >> 1]).toISOString(),
  raw_sha256: createHash('sha256').update(text).digest('hex'),
  canonical_sha256: createHash('sha256').update(canonicalize(text)).digest('hex'),
  note: 'Public orbital data from CelesTrak. Not affiliated with SpaceX or Starlink.',
};
writeFileSync(META, JSON.stringify(meta, null, 1) + '\n');
console.log(JSON.stringify(meta, null, 1));
