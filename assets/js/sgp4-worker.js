// STAR · SGP4 worker. Propagates the whole constellation off the main thread.
// satellite.js (MIT) from CDN, with a vendored fallback.
try { importScripts('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js'); }
catch (e) { importScripts('../vendor/satellite.min.js'); }
const S = self.satellite;
const RE = 6371.0;
let recs = [];

function parse(text) {
  const L = text.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const out = [];
  for (let i = 0; i < L.length; i++) {
    if (L[i].startsWith('1 ') && L[i + 1] && L[i + 1].startsWith('2 ')) {
      const p = i > 0 && !/^[12] /.test(L[i - 1]) ? L[i - 1].replace(/^0 /, '').trim() : '';
      out.push({ name: p || ('NORAD ' + L[i].slice(2, 7).trim()), l1: L[i], l2: L[i + 1] });
      i++;
    }
  }
  return out;
}
function epochMs(l1) {
  const yy = +l1.slice(18, 20), day = parseFloat(l1.slice(20, 32));
  return Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1) + (day - 1) * 86400000;
}
// ECF km → three.js coords in km (x=lon0, y=north, z=-lon90E)
function toThree(out, o, p) { out[o] = p.x; out[o + 1] = p.z; out[o + 2] = -p.y; } // km

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'init') {
    const all = parse(m.text);
    // canonical order (by NORAD) so indices match the proof script
    all.sort((a, b) => (+a.l1.slice(2, 7)) - (+b.l1.slice(2, 7)));
    let pick = all;
    if (all.length > m.max) { const step = all.length / m.max; pick = []; for (let k = 0; k < m.max; k++) pick.push(all[Math.floor(k * step)]); }
    // always keep requested ids (decider) in the render set
    for (const id of m.keep || []) if (!pick.some((s) => +s.l1.slice(2, 7) === +id)) { const s = all.find((x) => +x.l1.slice(2, 7) === +id); if (s) pick.push(s); }
    recs = []; const meta = [];
    const t0 = new Date(m.t);
    for (const s of pick) {
      const r = S.twoline2satrec(s.l1, s.l2);
      const pv = S.propagate(r, t0);
      if (r.error || !pv || !pv.position) continue;
      recs.push(r);
      meta.push({ l1: s.l1, l2: s.l2, name: s.name, norad: +s.l1.slice(2, 7), inc: +s.l2.slice(8, 16), mm: +s.l2.slice(52, 63), ecc: +('0.' + s.l2.slice(26, 33).trim()), epoch: epochMs(s.l1) });
    }
    const epochs = all.map((s) => epochMs(s.l1)).sort((a, b) => a - b);
    self.postMessage({ type: 'ready', total: all.length, sampled: pick.length < all.length, meta, epochNewest: epochs[epochs.length - 1], epochMedian: epochs[epochs.length >> 1] });
    return;
  }
  if (m.type === 'prop') {
    const d = new Date(m.t), g = S.gstime(d), n = recs.length;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const pv = S.propagate(recs[i], d);
      if (!pv || !pv.position) { pos[i * 3] = pos[i * 3 + 1] = pos[i * 3 + 2] = 0; continue; }
      toThree(pos, i * 3, S.eciToEcf(pv.position, g));
    }
    self.postMessage({ type: 'pos', id: m.id, t: m.t, gmst: g, pos }, [pos.buffer]);
    return;
  }
  if (m.type === 'detail') {
    // one satellite: geodetic + velocity + one orbit ring (ECI ring rotated into ECF at time t)
    const r = recs[m.i]; if (!r) return;
    const d = new Date(m.t), g = S.gstime(d);
    const pv = S.propagate(r, d);
    if (!pv || !pv.position) return;
    const geo = S.eciToGeodetic(pv.position, g);
    const v = pv.velocity, vel = Math.hypot(v.x, v.y, v.z);
    const periodMin = 1440 / (r.no * 1440 / (2 * Math.PI));
    const N = 160, ring = new Float32Array((N + 1) * 3);
    for (let k = 0; k <= N; k++) {
      const tk = new Date(m.t - (periodMin * 60000) * (1 - k / N));
      const p = S.propagate(r, tk);
      if (p && p.position) toThree(ring, k * 3, S.eciToEcf(p.position, g)); // freeze frame at g → clean ellipse
    }
    self.postMessage({ type: 'detail', i: m.i, req: m.req, lat: S.degreesLat(geo.latitude), lon: S.degreesLong(geo.longitude), alt: geo.height, vel, periodMin, ring }, [ring.buffer]);
  }
};
