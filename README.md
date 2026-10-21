# $STAR · Starborn: static site

"The first coin whose address was decided by the Starlink constellation in orbit."
This is a plain HTML/CSS/JS site. Three.js and satellite.js (SGP4) load from the jsDelivr CDN, and satellite.js has a vendored fallback. There is no build step.
It is **not affiliated with SpaceX or Starlink.** It only uses public orbital data from [CelesTrak](https://celestrak.org).

```
python3 -m http.server 4950     # then open http://localhost:4950
```

## Files
| path | what |
|---|---|
| `index.html` | page and meta tags. Set absolute `og:image` / `twitter:image` URLs once the domain exists |
| `config.js` | **the only file to edit at launch**: CA, BUY_URL, X_URL, TREASURY, COMMIT and REVEAL fields, TLE options |
| `assets/js/orbit.js` | Three.js Earth (day/night/specular/clouds and a Fresnel atmosphere), the real Sun position for the current UTC, satellites, picking and the orbit ring |
| `assets/js/sgp4-worker.js` | Web Worker that runs SGP4 on the whole constellation and posts keyframes. The GPU interpolates between them |
| `assets/js/main.js` | loader, TLE loading, HUD, shell stats, sky hash, provenance state, DexScreener and RPC |
| `assets/data/starlink.tle` (+ `.meta.json`) | bundled CelesTrak Starlink element set |
| `scripts/fetch-tles.mjs` | refreshes the bundled TLE file |
| `scripts/make-commit.mjs` | STEP 1: makes the secret entropy (saved to `~/.star-mint/`, outside the repo) and prints the public commitment |
| `scripts/derive-star-address.mjs` | STEPS 3–4: recomputes the address from a snapshot. `--test` runs a public test vector |
| `scripts/star-lib.mjs` | canonicalization, HKDF, Ed25519 and base58. Zero dependencies, Node ≥ 18 |

## Orbital data: how it loads
1. The page fetches the **bundled** `assets/data/starlink.tle`. It's same-origin, fast and always works.
2. `config.TLE.LIVE_REFRESH = 'stale'` (the default): if the bundled set is older than `STALE_HOURS` (12 h), the browser fetches the live set from CelesTrak. CelesTrak sends `Access-Control-Allow-Origin: *`. The result is cached in localStorage for 2 h. If the fetch fails, the bundled set is used.
3. Every satellite is propagated to the current UTC second with SGP4, so the globe is live even when the element set is a few hours old.

Refresh the bundled set before each deploy, or on a cron:
```
node scripts/fetch-tles.mjs
```
CelesTrak updates GP data about every 2 h. If you download the same GROUP+FORMAT again before it changes, it returns **403 "has not updated"**. That's expected, and the script keeps the existing file. Don't hammer it.

Performance: desktop renders up to 12,000 satellites, and mobile subsamples to 4,000 (the HUD shows "rendered / total"). Satellites that fail SGP4 because they've decayed are dropped and counted.

## STAR-MINT-v1 derivation (exact)
```
canonical  = TLE parsed → sorted by NORAD id → "NAME\nLINE1\nLINE2\n" per sat (names trimmed, lines right-trimmed, LF, UTF-8)
snap_hash  = SHA-256(canonical)
seed       = HKDF-SHA256(ikm = entropy(32 bytes) || snap_hash,
                         salt = "STAR-MINT-v1",
                         info = "STARLINK-GP|" + snapshot_utc (ISO-8601, ms, Z),
                         L = 32)
mint       = Ed25519.fromSeed(seed).publicKey  (= Solana Keypair.fromSeed(seed); cross-checked vs @solana/web3.js)
decider    = sats[ uint64_be(SHA-256("STAR-DECIDER" || seed)[0..8]) mod N ]   (flavor only)
```
**Why secret entropy:** the snapshot is public the moment it's taken. Without the sealed entropy, anyone could compute the mint key at the same time we do. Its `sha256` is committed ahead of time, and the entropy is revealed only after the mint exists.

### Launch runbook
1. `node scripts/make-commit.mjs --time <future UTC>`, then post the printed `snapshot_utc`, `entropy_commitment_sha256` and `rules_sha256` publicly. Put them in `config.COMMIT`.
2. At the snapshot second, run `curl -o proof/snapshot.tle "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=3le"`. Don't hit that URL in the 2 h before, or it returns a 403.
3. `node scripts/derive-star-address.mjs --snapshot proof/snapshot.tle --time <UTC> --entropy $(cat ~/.star-mint/entropy.hex)`. That prints the address. Build the mint keypair from `seed` locally (never commit it) and create the token.
4. After mint, fill in `config.CA`, the `REVEAL` fields (including `ENTROPY` and `DECIDER_NORAD`), and commit `proof/snapshot.tle` and `proof/proof.json`.

Note: a pump.fun "…pump" vanity suffix is **not** compatible with this derivation, because the address is whatever the math gives.

## Verify
```
node scripts/derive-star-address.mjs --snapshot proof/snapshot.tle --time <SNAPSHOT_UTC> --entropy <ENTROPY> --expect <CA>
```
