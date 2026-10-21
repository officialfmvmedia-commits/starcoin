// STAR · passthrough data layer. Every value shown here is read from the loaded TLE set and the live SGP4 state.
const fmt = (n) => Math.round(n).toLocaleString();
const rng = (km) => (km < 1 ? Math.round(km * 1000) + ' m' : km < 100 ? km.toFixed(1) + ' km' : fmt(km) + ' km');
export function createDataLayer(orbit, { root, skyHash }) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lite = () => orbit.mobile || orbit.tierNow === 'low';
  const W = () => innerWidth, H = () => innerHeight;
  // regions that must stay clear (hero text / CTA / HUD cards)
  let hr = null, hrAt = 0;
  const onHero = (x, y) => { const n = performance.now(); if (n - hrAt > 250) { hrAt = n; hr = orbit.heroRect ? orbit.heroRect() : null; } return hr && x > hr.x0 && x < hr.x1 && y > hr.y0 && y < hr.y1; };
  const blocked = (x, y) => {
    if (onHero(x, y)) return true;
    if (orbit.mobile) return y > H() * 0.43 || y < H() * 0.17;
    return x < W() * 0.5 || (x > W() - 340 && (y < 190 || y > H() - 250));
  };
  const el = (cls, html = '') => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; root.appendChild(d); return d; };

  // ── 3D-anchored labels with leader lines ──
  const labels = new Map(); // i → {box, line, dx, dy, born}
  let lastPick = 0;
  function pickLabels(now) {
    const maxL = lite() ? 1 : 3, t = orbit.tracked, h = orbit.host;
    for (const [i, L] of labels) if (now - L.born > 7500 || !orbit.onScreen(i, 0.95)) kill(i);
    if (labels.size >= maxL) return;
    const cand = orbit.near.filter((i) => i !== t && i !== h && !labels.has(i)).map((i) => ({ i, s: orbit.onScreen(i, 0.8) })).filter((c) => c.s && !blocked(c.s.x, c.s.y));
    cand.sort((a, b) => a.s.d - b.s.d);
    for (const c of cand) {
      if (labels.size >= maxL) break;
      if ([...labels.values()].some((L) => Math.hypot(L.x - c.s.x, L.y - c.s.y) < 170)) continue;
      const ts = t >= 0 ? orbit.onScreen(t, 0.95) : null; if (ts && Math.hypot(ts.x - c.s.x, ts.y - c.s.y) < 230) continue;
      const dxs = c.s.x > W() * 0.78 ? -1 : 1; if (blocked(c.s.x + dxs * 150, c.s.y - 56)) continue;
      const m = orbit.meta[c.i];
      const box = el('dl-chip', `<b>${m.name}</b><span>#${m.norad}</span><em></em>`), line = el('dl-lead');
      const dx = dxs * (60 + Math.random() * 40), dy = -(36 + Math.random() * 40);
      labels.set(c.i, { box, line, dx, dy, born: now, x: c.s.x, y: c.s.y, upd: 0 });
      requestAnimationFrame(() => { box.classList.add('on'); line.classList.add('on'); });
    }
  }
  function kill(i) { const L = labels.get(i); if (!L) return; labels.delete(i); L.box.classList.remove('on'); L.line.classList.remove('on'); setTimeout(() => { L.box.remove(); L.line.remove(); }, 900); }
  function placeLabels(now) {
    for (const [i, L] of labels) {
      const s = orbit.onScreen(i, 1.0); if (!s) { kill(i); continue; }
      L.x = s.x; L.y = s.y;
      const bx = s.x + L.dx, by = s.y + L.dy, len = Math.hypot(L.dx, L.dy), ang = Math.atan2(L.dy, L.dx);
      L.box.style.transform = `translate(${bx.toFixed(1)}px,${by.toFixed(1)}px) translate(${L.dx < 0 ? '-100%' : '0'},-50%)`;
      L.line.style.transform = `translate(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px) rotate(${ang}rad)`; L.line.style.width = len.toFixed(1) + 'px';
      if (now - L.upd > 500) { L.upd = now; const g = orbit.geo(i); if (g) L.box.querySelector('em').textContent = `ALT ${fmt(g.alt)} km · ${g.vel.toFixed(2)} km/s · RNG ${rng(g.range)}${g.lit ? '' : ' · SHADOW'}`; }
    }
  }

  // ── drifting TLE fragments (real lines) ──
  let lastTle = 0, tleCount = 0;
  function spawnTLE(now) {
    const maxT = lite() ? 1 : 5, every = lite() ? 6500 : 2100;
    if (now - lastTle < every || tleCount >= maxT || !orbit.meta.length) return; lastTle = now;
    const pool = orbit.near.length ? orbit.near : [0], i = pool[(Math.random() * pool.length) | 0], m = orbit.meta[i];
    const line = Math.random() < 0.5 ? m.l1 : m.l2;
    const f = el('dl-tle' + (reduce ? ' still' : ''), line.replace(/ /g, '&nbsp;'));
    const y = orbit.mobile ? H() * (0.19 + Math.random() * 0.2) : H() * (0.2 + Math.random() * 0.62);
    const x = orbit.mobile ? W() * (0.1 + Math.random() * 0.2) : W() * (0.56 + Math.random() * 0.12);
    if ((!orbit.mobile && x > W() - 340 && (y < 190 || y > H() - 250)) || onHero(x, y) || onHero(x + 300, y)) { f.remove(); return; }
    f.style.left = x + 'px'; f.style.top = y + 'px'; f.style.setProperty('--dz', (0.75 + Math.random() * 0.5).toFixed(2));
    f.style.animationDuration = (10 + Math.random() * 5).toFixed(1) + 's';
    tleCount++;
    if (reduce) { f.style.opacity = '.2'; setTimeout(() => { f.remove(); tleCount--; }, 9000); }
    else f.addEventListener('animationend', () => { f.remove(); tleCount--; });
  }

  // ── ticker strip ──
  const tick = el('dl-ticker'); let tickIdx = 0, tickAt = performance.now() + 2500, tickOn = false;
  const shells = () => { const b = [[52.5, 53.6, '53°'], [42.5, 43.5, '43°'], [69.5, 70.5, '70°'], [96.5, 98.5, '97.6°']]; return b.map(([lo, hi, k]) => `${k} <b>${fmt(orbit.meta.filter((m) => m.inc >= lo && m.inc < hi).length)}</b>`).join(' · '); };
  let shellStr = '';
  function tickerText() {
    const st = orbit.stats, items = [];
    if (st.at) items.push(`<i></i>LIVE · <b>${fmt(orbit.N)}</b> SATELLITES PROPAGATED · <b>${fmt(st.sunlit)}</b> SUNLIT · <b>${fmt(st.shadow)}</b> IN EARTH SHADOW`);
    if (!shellStr && orbit.meta.length) shellStr = shells();
    if (shellStr) items.push(`SHELLS · ${shellStr}`);
    const np = orbit.nextPass(); if (np) items.push(`NEXT CLOSE PASS · <b>${np.name}</b> IN <b>${Math.round(np.tca)} s</b> · MISS ${rng(np.miss)} · REL ${np.vrel.toFixed(2)} km/s <span>LINEAR EST.</span>`);
    const sh = skyHash(), xh = orbit.stateHash;
    if (sh) items.push(`SKY HASH · TLE SET <b>${sh.slice(0, 12)}…</b>${xh ? ` · STATE @ ${new Date(orbit.stateHashAt).toISOString().slice(11, 19)}Z <b>${xh.slice(0, 12)}…</b>` : ''}`);
    return items.length ? items[tickIdx++ % items.length] : '';
  }
  function runTicker(now) {
    if (now < tickAt) return;
    if (tickOn) { tick.classList.remove('on'); tickOn = false; tickAt = now + (lite() ? 7000 : 2600); return; }
    const t = tickerText(); if (!t) { tickAt = now + 1000; return; }
    tick.innerHTML = t; tick.classList.add('on'); tickOn = true; tickAt = now + 6500;
  }

  // ── faint orbital elements of the tracked satellite ──
  const elBox = el('dl-elem'); let elFor = -1, elUpd = 0;
  function elements(now) {
    const i = orbit.tracked, s = i >= 0 ? orbit.onScreen(i, 0.95) : null;
    if (!s || blocked(s.x, s.y) || blocked(s.x + 170, s.y + 60) || (orbit.mobile && lite() && i !== orbit.host)) { elBox.classList.remove('on'); return; }
    if (i !== elFor || now - elUpd > 1000) {
      elFor = i; elUpd = now; const m = orbit.meta[i], l1 = m.l1, l2 = m.l2;
      const inc = +l2.slice(8, 16), raan = +l2.slice(17, 25), ecc = +('0.' + l2.slice(26, 33).trim()), argp = +l2.slice(34, 42), ma0 = +l2.slice(43, 51), mm = +l2.slice(52, 63);
      const maNow = (((ma0 + mm * 360 * ((orbit.simT - m.epoch) / 86400000)) % 360) + 360) % 360;
      elBox.innerHTML = `<div>INC <b>${inc.toFixed(4)}°</b></div><div>RAAN <b>${raan.toFixed(4)}°</b></div><div>ECC <b>${ecc.toFixed(7)}</b></div><div>ARGP <b>${argp.toFixed(4)}°</b></div><div>M <b>${maNow.toFixed(2)}°</b> <span>now</span></div><div>n <b>${mm.toFixed(8)}</b> rev/d</div><div>EPOCH <b>${l1.slice(18, 32).trim()}</b></div>`;
    }
    const sz = Math.max(26, Math.min(orbit.mobile ? 70 : 110, 60 / Math.pow(Math.max(s.d, 0.02), 0.35)));
    elBox.style.transform = `translate(${(s.x + sz / 2 + 12).toFixed(1)}px,${(s.y + sz / 2 - 4).toFixed(1)}px)`; elBox.classList.add('on');
  }

  orbit.onFrame = () => {
    const now = performance.now(), hidden = scrollY > innerHeight * 0.45 || document.body.classList.contains('is-loading');
    root.classList.toggle('off', hidden); if (hidden) return;
    if (now - lastPick > 3500) { lastPick = now; pickLabels(now); }
    placeLabels(now); spawnTLE(now); runTicker(now); elements(now);
  };
}
