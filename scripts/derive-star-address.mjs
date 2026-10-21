#!/usr/bin/env node
// STAR-MINT-v1 · recompute the $STAR mint address from a saved Starlink snapshot.
//
//   node scripts/derive-star-address.mjs --snapshot proof/snapshot.tle \
//        --time 2026-11-01T18:00:00.000Z --entropy <64 hex chars> [--expect <mint address>]
//
//   node scripts/derive-star-address.mjs --test      # test vector on the bundled data (entropy = 00 01 … 1f)
//
// Prints a JSON proof. Never prints the secret key. Zero dependencies (Node ≥18).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, parseTLE, sha256, deriveSeed, ed25519FromSeed, base58, RULES } from './star-lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]); return a; }, []));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let snapFile = args.snapshot, time = args.time, entropyHex = args.entropy;
if (args.test) {
  snapFile = join(ROOT, 'assets/data/starlink.tle');
  time = '2000-01-01T00:00:00.000Z';
  entropyHex = Buffer.from([...Array(32).keys()]).toString('hex');
}
if (!snapFile || !time || !entropyHex) {
  console.error('usage: --snapshot <file> --time <ISO UTC> --entropy <hex32> [--expect <addr>]   |   --test');
  process.exit(2);
}
if (!/^[0-9a-f]{64}$/i.test(entropyHex)) { console.error('entropy must be 64 hex chars'); process.exit(2); }
if (isNaN(Date.parse(time))) { console.error('bad --time'); process.exit(2); }
const snapshotUtc = new Date(time).toISOString();

const raw = readFileSync(snapFile);
const canon = canonicalize(raw.toString('utf8'));
const sats = parseTLE(canon.toString('utf8'));
const snapHash = sha256(canon);
const entropy = Buffer.from(entropyHex, 'hex');
const seed = deriveSeed(entropy, snapHash, snapshotUtc);
const kp = ed25519FromSeed(seed);
const address = base58(kp.publicKey);
const di = Number(sha256(Buffer.concat([Buffer.from('STAR-DECIDER'), seed])).readBigUInt64BE(0) % BigInt(sats.length));
const decider = sats[di];

const proof = {
  version: RULES.version,
  test_vector: !!args.test,
  snapshot_file: snapFile.replace(ROOT + '/', ''),
  snapshot_utc: snapshotUtc,
  satellites: sats.length,
  raw_sha256: sha256(raw).toString('hex'),
  canonical_sha256: snapHash.toString('hex'),
  entropy_commitment_sha256: sha256(entropy).toString('hex'),
  entropy_revealed: entropyHex.toLowerCase(),
  salt: RULES.salt,
  info: RULES.info(snapshotUtc),
  derivation: RULES.derivation,
  address,
  decider: { rule: RULES.decider, index: di, name: decider.name, norad: decider.norad, line1: decider.l1, line2: decider.l2 },
};
if (args.expect && args.expect !== true) {
  proof.expected = args.expect; proof.match = args.expect === address;
}
console.log(JSON.stringify(proof, null, 1));
if (proof.match === false) process.exit(1);
