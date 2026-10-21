# proof/

Empty until launch. After the mint exists, put these here (and set the REVEAL fields in `config.js`):

- `snapshot.tle` is the exact CelesTrak Starlink file downloaded at `COMMIT.SNAPSHOT_UTC`, unmodified.
- `proof.json` is the output of `node scripts/derive-star-address.mjs --snapshot proof/snapshot.tle --time <SNAPSHOT_UTC> --entropy <ENTROPY> --expect <CA>`.
