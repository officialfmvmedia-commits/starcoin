// ─────────────────────────────────────────────────────────────
//  STAR · STARBORN — site config. Edit these values, nothing else.
//  Leave a value as '' to show the intentional "SOON / AWAITING" state.
//  Never put a private key or the secret entropy here before the reveal.
// ─────────────────────────────────────────────────────────────
export const CONFIG = {
  NAME: 'Starborn',
  TICKER: 'STAR',
  CA: 'Ajw34HAAG3myVbuCJFsEtvsmicdw1BeRK95E1YLs2qPg',          // token mint address. '' → "AWAITING CA"
  BUY_URL: 'https://pump.fun/coin/Ajw34HAAG3myVbuCJFsEtvsmicdw1BeRK95E1YLs2qPg',     // '' → derived as https://pump.fun/coin/<CA> once CA is set
  X_URL: 'https://x.com/projectstarcoin',     // e.g. 'https://x.com/<handle>'. '' → "SOON"
  TREASURY: '',    // optional PUBLIC wallet address. '' → treasury card hidden

  // ── STEP 1 · COMMIT (publish BEFORE the snapshot; from scripts/make-commit.mjs) ──
  COMMIT: {
    SNAPSHOT_UTC: '2026-10-22T00:00:00.000Z',          // e.g. '2026-11-01T18:00:00.000Z' → shows a live countdown
    ENTROPY_COMMITMENT: 'f78a4262d50befbe565253a8b78a55b9e1e9fc23ea2c22c729b75648b8e6f1b2',    // sha256(entropy) hex
    RULES_SHA256: '9152441e0623d48d14d44753e81092843d18d5df11a2343d63ffaff07e3610f4',          // sha256 of the rules JSON printed by make-commit
    URL: '',                   // link to the public commit post (X post / gist / tx)
  },
  // ── STEPS 2–4 · REVEAL (fill AFTER the mint exists; from scripts/derive-star-address.mjs) ──
  REVEAL: {
    SNAPSHOT_SHA256: '0e6733e30ad923895b8678a0485fcaccf0468f122de064a2e715f50049a0fdd4',       // canonical_sha256 of the snapshot that decided the address
    SATELLITES: 10648,             // satellites in that snapshot
    ENTROPY: 'ffacac4fc20177b322d0eb11d6a803e414036d1de1962b6aa916464ec4aeb08b',               // revealed entropy hex (only after mint!)
    SNAPSHOT_URL: 'proof/snapshot.tle',          // where the raw snapshot file is published (e.g. proof/snapshot.tle)
    DECIDER_NORAD: '62025',         // NORAD id of the "decider" satellite → highlighted on the globe
    DECIDER_NAME: 'STARLINK-32493',
  },

  // ── orbital data ──
  TLE: {
    BUNDLED: 'assets/data/starlink.tle',          // refreshed by `node scripts/fetch-tles.mjs`
    META: 'assets/data/starlink.meta.json',
    LIVE_URL: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=3le',
    LIVE_REFRESH: 'stale',  // 'off' | 'stale' (only if bundled set older than STALE_HOURS) | 'always'
    STALE_HOURS: 12,
    CACHE_HOURS: 2,         // live result cached in localStorage; CelesTrak updates every ~2h
  },
  MAX_SATS_DESKTOP: 12000,
  MAX_SATS_MOBILE: 4000,

  // ── treasury balance (Solana RPC; only used once TREASURY is set) ──
  RPC_URLS: [
    'https://solana-rpc.publicnode.com',
    'https://api.mainnet-beta.solana.com',
    'https://solana.leorpc.com/?api_key=FREE',
    'https://solana.api.onfinality.io/public',
  ],
  POLL_SECONDS: 45,
};
