// ─────────────────────────────────────────────────────────────
//  STAR · STARBORN — site config. Edit these values, nothing else.
//  Leave a value as '' to show the intentional "SOON / AWAITING" state.
//  Never put a private key or the secret entropy here before the reveal.
// ─────────────────────────────────────────────────────────────
export const CONFIG = {
  NAME: 'Starborn',
  TICKER: 'STAR',
  CA: '',          // token mint address. '' → "AWAITING CA"
  BUY_URL: '',     // '' → derived as https://pump.fun/coin/<CA> once CA is set
  X_URL: 'https://x.com/projectstarcoin',     // e.g. 'https://x.com/<handle>'. '' → "SOON"
  TREASURY: '',    // optional PUBLIC wallet address. '' → treasury card hidden

  // ── STEP 1 · COMMIT (publish BEFORE the snapshot; from scripts/make-commit.mjs) ──
  COMMIT: {
    SNAPSHOT_UTC: '',          // e.g. '2026-11-01T18:00:00.000Z' → shows a live countdown
    ENTROPY_COMMITMENT: '',    // sha256(entropy) hex
    RULES_SHA256: '',          // sha256 of the rules JSON printed by make-commit
    URL: '',                   // link to the public commit post (X post / gist / tx)
  },
  // ── STEPS 2–4 · REVEAL (fill AFTER the mint exists; from scripts/derive-star-address.mjs) ──
  REVEAL: {
    SNAPSHOT_SHA256: '',       // canonical_sha256 of the snapshot that decided the address
    SATELLITES: 0,             // satellites in that snapshot
    ENTROPY: '',               // revealed entropy hex (only after mint!)
    SNAPSHOT_URL: '',          // where the raw snapshot file is published (e.g. proof/snapshot.tle)
    DECIDER_NORAD: '',         // NORAD id of the "decider" satellite → highlighted on the globe
    DECIDER_NAME: '',
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

  // ── market data (only used once CA is set) ──
  RPC_URLS: [
    'https://solana-rpc.publicnode.com',
    'https://api.mainnet-beta.solana.com',
    'https://solana.leorpc.com/?api_key=FREE',
    'https://solana.api.onfinality.io/public',
  ],
  DEXSCREENER: 'https://api.dexscreener.com/latest/dex/tokens/',
  POLL_SECONDS: 45,
};
