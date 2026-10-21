#!/usr/bin/env node
// STAR-MINT-v1 · STEP 1 (COMMIT). Run once, privately, before launch.
//   node scripts/make-commit.mjs --time 2026-11-01T18:00:00Z
// Generates 32 random bytes of entropy, saves them OUTSIDE the repo (~/.star-mint/entropy.hex, mode 600),
// and prints the public commitment to post: sha256(entropy), rules hash, and the future snapshot time.
// Keep entropy secret until after the mint exists — otherwise anyone could pre-compute the address.
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RULES } from './star-lib.mjs';
const i = process.argv.indexOf('--time'); const t = i > 0 ? process.argv[i + 1] : null;
if (!t || isNaN(Date.parse(t))) { console.error('usage: --time <future ISO UTC>'); process.exit(2); }
const dir = join(homedir(), '.star-mint'), f = join(dir, 'entropy.hex');
if (existsSync(f)) { console.error(`${f} already exists — refusing to overwrite.`); process.exit(1); }
mkdirSync(dir, { recursive: true, mode: 0o700 });
const e = randomBytes(32); writeFileSync(f, e.toString('hex') + '\n', { mode: 0o600 });
const snapshotUtc = new Date(t).toISOString();
const rulesText = JSON.stringify({ version: RULES.version, salt: RULES.salt, info: RULES.info(snapshotUtc), derivation: RULES.derivation, decider: RULES.decider,
  snapshot_source: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=3le', canonical: 'parse, sort by NORAD id, NAME\\nL1\\nL2\\n, LF, UTF-8' });
console.log(JSON.stringify({ snapshot_utc: snapshotUtc, entropy_commitment_sha256: createHash('sha256').update(e).digest('hex'),
  rules_sha256: createHash('sha256').update(rulesText).digest('hex'), rules: JSON.parse(rulesText), entropy_saved_to: f }, null, 1));
