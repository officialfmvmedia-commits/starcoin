// STAR-MINT-v1 shared helpers (Node ≥18, zero dependencies).
import { createHash, hkdfSync, createPrivateKey, createPublicKey } from 'node:crypto';

// Parse 2-line or 3-line TLE text → [{name, norad, l1, l2, epochMs}]
export function parseTLE(text) {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('1 ') && lines[i + 1]?.startsWith('2 ')) {
      const prev = i > 0 && !lines[i - 1].startsWith('1 ') && !lines[i - 1].startsWith('2 ') ? lines[i - 1] : '';
      const l1 = lines[i], l2 = lines[i + 1];
      const name = prev.replace(/^0 /, '').trim() || `NORAD ${l1.slice(2, 7).trim()}`;
      out.push({ name, norad: parseInt(l1.slice(2, 7), 10), l1, l2, epochMs: tleEpochMs(l1) });
      i++;
    }
  }
  return out;
}
export function tleEpochMs(l1) {
  const yy = parseInt(l1.slice(18, 20), 10), day = parseFloat(l1.slice(20, 32));
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return Date.UTC(year, 0, 1) + (day - 1) * 86400000;
}

// CANONICAL SNAPSHOT (STAR-MINT-v1):
//   parse every TLE, sort by NORAD id ascending (ties: line1 then line2),
//   emit "NAME\nLINE1\nLINE2\n" per satellite, names trimmed, lines right-trimmed, LF only, UTF-8.
// Canonical form makes the hash independent of server ordering / CRLF / padding.
export function canonicalize(text) {
  const s = parseTLE(text).sort((a, b) => a.norad - b.norad || (a.l1 < b.l1 ? -1 : a.l1 > b.l1 ? 1 : a.l2 < b.l2 ? -1 : a.l2 > b.l2 ? 1 : 0));
  return Buffer.from(s.map((x) => `${x.name}\n${x.l1}\n${x.l2}\n`).join(''), 'utf8');
}
export const sha256 = (b) => createHash('sha256').update(b).digest();

export const RULES = {
  version: 'STAR-MINT-v1',
  salt: 'STAR-MINT-v1',
  info: (snapshotUtc) => `STARLINK-GP|${snapshotUtc}`,
  derivation: 'seed = HKDF-SHA256(ikm = entropy(32B) || sha256(canonical_snapshot), salt = "STAR-MINT-v1", info = "STARLINK-GP|<snapshot_utc>", L = 32); mint keypair = Ed25519.fromSeed(seed)',
  decider: 'decider_index = uint64_be(sha256("STAR-DECIDER" || seed)[0..8]) mod N  (N = satellites in canonical order)',
};

export function deriveSeed(entropy, snapHash, snapshotUtc) {
  if (entropy.length !== 32) throw new Error('entropy must be 32 bytes');
  return Buffer.from(hkdfSync('sha256', Buffer.concat([entropy, snapHash]), RULES.salt, RULES.info(snapshotUtc), 32));
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0')), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
// Ed25519 keypair from 32-byte seed — identical to Solana Keypair.fromSeed(seed).
export function ed25519FromSeed(seed) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pub = Buffer.from(createPublicKey(priv).export({ format: 'jwk' }).x, 'base64url');
  return { publicKey: pub, secretKey: Buffer.concat([seed, pub]) };
}
