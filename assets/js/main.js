// STAR · page logic: data loading, HUD, provenance state, live market data.
import { CONFIG } from '../../config.js';
import { createOrbit } from './orbit.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const mobile = matchMedia('(max-width: 760px), (pointer: coarse)').matches;
const ca = (CONFIG.CA || '').trim();
const short = (s, a = 6, b = 6) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);

// ── loader ──
const prog = { tex: 0, data: 0, sats: 0 };
function setProg(k, v, msg) {
  prog[k] = v; const p = prog.tex * 0.3 + prog.data * 0.4 + prog.sats * 0.3;
  $('#ld-fill').style.width = (p * 100).toFixed(1) + '%';
  if (msg) $('#ld-status').textContent = msg;
}
let loaderDone = false;
function hideLoader() {
  if (loaderDone) return; loaderDone = true;
  document.body.classList.remove('is-loading'); $('#loader').classList.add('done');
  setTimeout(() => $('#loader').remove(), 1400);
}
setTimeout(() => { if (!loaderDone) { $('#ld-status').textContent = 'SLOW LINK · CONTINUING'; hideLoader(); } }, 14000);

// ── orbit ──
const decider = (CONFIG.REVEAL.DECIDER_NORAD || '').toString().trim();
let orbit;
try {
  orbit = createOrbit({
    canvas: $('#sky'),
    max: mobile ? CONFIG.MAX_SATS_MOBILE : CONFIG.MAX_SATS_DESKTOP,
    keep: decider ? [decider] : [],
    onProgress: (k, v, info) => {
      if (k === 'tex') setProg('tex', v);
      if (k === 'sats') { setProg('sats', 1, `PROPAGATING ${info.rendered.toLocaleString()} ORBITS`); onSatsReady(info); }
    },
    onFirstFrame: () => { setProg('sats', 1, 'LOCKED'); setTimeout(hideLoader, 350); },
    onSelect: (s) => { $('#reticle').dataset.name = s.name; $('#sat-name').textContent = s.name + (s.why === 'decider' ? ' · DECIDER' : s.why === 'host' ? ' · RIDING' : ''); $('#sat-norad').textContent = s.norad; $('#sat-inc').textContent = s.inc.toFixed(1) + '°'; },
    onDetail: (d) => {
      $('#sat-alt').textContent = Math.round(d.alt).toLocaleString() + ' km';
      $('#sat-vel').textContent = d.vel.toFixed(2) + ' km/s';
      $('#sat-rng').textContent = d.range < 1 ? Math.round(d.range * 1000) + ' m' : d.range < 100 ? d.range.toFixed(1) + ' km' : Math.round(d.range).toLocaleString() + ' km';
      $('#sat-ll').textContent = `${Math.abs(d.lat).toFixed(1)}°${d.lat >= 0 ? 'N' : 'S'} ${Math.abs(d.lon).toFixed(1)}°${d.lon >= 0 ? 'E' : 'W'}`;
      $('#sat-sun').textContent = d.lit ? 'SUNLIT' : 'IN EARTH SHADOW';
      $('#hud-cam').textContent = `${Math.round(d.camAlt)} km · riding ${d.host}`;
      $('#reticle').dataset.name = d.name;
      $('#reticle').dataset.rng = $('#sat-rng').textContent;
    },
  });
} catch (e) {
  console.warn('[orbit] WebGL unavailable:', e.message);
  document.body.classList.add('no-webgl'); hideLoader();
}
if (orbit) {
  const ret = $('#reticle');
  orbit.onLabel = (x, y, hidden, range) => {
    const sz = Math.max(26, Math.min(mobile ? 70 : 110, 60 / Math.pow(Math.max(range, 0.02), 0.35)));
    ret.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
    ret.style.setProperty('--s', sz.toFixed(0) + 'px');
    ret.classList.toggle('hidden', hidden || scrollY > innerHeight * 0.55);
  };
}

// ── TLE loading: bundled snapshot (fast, reliable) → optional live refresh from CelesTrak ──
let tleSource = 'bundled', tleText = '';
async function fetchText(url, ms = 12000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.text(); }
  finally { clearTimeout(t); }
}
const looksLikeTLE = (t) => (t.match(/^1 \d{5}/gm) || []).length > 1000;
async function loadTLE() {
  const T = CONFIG.TLE;
  setProg('data', 0.1, 'ACQUIRING CONSTELLATION');
  let meta = null;
  try { meta = JSON.parse(await fetchText(T.META, 6000)); } catch {}
  // 1) fresh cached live copy?
  let cached = null;
  try { const c = JSON.parse(localStorage.getItem('star-tle') || 'null'); if (c && Date.now() - c.at < T.CACHE_HOURS * 3600e3 && looksLikeTLE(c.text)) cached = c; } catch {}
  const bundledAgeH = meta ? (Date.now() - Date.parse(meta.epoch_newest)) / 3600e3 : Infinity;
  const wantLive = T.LIVE_REFRESH === 'always' || (T.LIVE_REFRESH === 'stale' && bundledAgeH > T.STALE_HOURS);
  if (cached && wantLive) { tleText = cached.text; tleSource = 'celestrak · cached'; }
  else {
    try { tleText = await fetchText(T.BUNDLED); tleSource = 'bundled snapshot'; } catch (e) { console.warn('[tle] bundled failed', e.message); }
    if ((wantLive || !tleText) && T.LIVE_URL) {
      try {
        setProg('data', 0.5, 'REFRESHING FROM CELESTRAK');
        const live = await fetchText(T.LIVE_URL, 15000);
        if (looksLikeTLE(live)) { tleText = live; tleSource = 'celestrak · live'; try { localStorage.setItem('star-tle', JSON.stringify({ at: Date.now(), text: live })); } catch {} }
      } catch (e) { console.info('[tle] live refresh unavailable, using bundled:', e.message); }
    }
  }
  if (!tleText) { $('#ld-status').textContent = 'ORBITAL DATA UNAVAILABLE'; hideLoader(); return; }
  setProg('data', 1, 'PROPAGATING ORBITS · SGP4');
  orbit && orbit.load(tleText);
  skyHash(tleText);
}
loadTLE();

// ── HUD ──
function fmtAge(ms) { const h = ms / 3600e3; return h < 1 ? Math.max(1, Math.round(h * 60)) + ' MIN' : h < 48 ? h.toFixed(1) + ' H' : (h / 24).toFixed(1) + ' D'; }
let info = null;
function onSatsReady(i) {
  info = i;
  $('#hud-count').textContent = i.total.toLocaleString();
  $('#hud-render').textContent = `${i.rendered.toLocaleString()} / ${i.total.toLocaleString()}` + (i.sampled ? ' · MOBILE LOD' : i.rendered < i.total ? ` · ${i.total - i.rendered} DECAYED` : '');
  $('#hud-src').textContent = tleSource.toUpperCase();
  renderShells(i.meta);
}
setInterval(() => {
  const now = orbit ? orbit.simT : Date.now(), d = new Date(now);
  $('#hud-utc').textContent = 'UTC ' + d.toISOString().slice(0, 19).replace('T', ' ');
  if (info) $('#hud-age').textContent = fmtAge(Date.now() - info.epochMedian) + ' (median epoch)';
  tickCountdown();
}, 250);
$$('[data-warp]').forEach((b) => b.addEventListener('click', () => {
  $$('[data-warp]').forEach((x) => x.classList.toggle('on', x === b));
  orbit && orbit.setWarp(+b.dataset.warp);
}));

function renderShells(meta) {
  const buckets = [
    { k: '53°', lo: 52.5, hi: 53.6, d: 'Main shells — mid-latitudes' },
    { k: '43°', lo: 42.5, hi: 43.5, d: 'Low-inclination shells' },
    { k: '70°', lo: 69.5, hi: 70.5, d: 'High-latitude shell' },
    { k: '97.6°', lo: 96.5, hi: 98.5, d: 'Polar / sun-synchronous' },
  ];
  const total = meta.length; let used = 0;
  const rows = buckets.map((b) => { const n = meta.filter((m) => m.inc >= b.lo && m.inc < b.hi).length; used += n; return { ...b, n }; });
  rows.push({ k: 'other', d: 'Raising, deorbiting or other planes', n: total - used });
  const mx = Math.max(...rows.map((r) => r.n));
  $('#shell-rows').innerHTML = rows.map((r) => `<div class="shell"><span class="mono sk">${r.k}</span><span class="sd">${r.d}</span><span class="sb"><i style="width:${(r.n / mx * 100).toFixed(1)}%"></i></span><span class="mono sn">${r.n.toLocaleString()}</span></div>`).join('');
  $('#shells-note').textContent = `${total.toLocaleString()} satellites rendered · inclination from the loaded element set`;
}

// ── sky hash (same canonicalization as scripts/star-lib.mjs) ──
async function skyHash(text) {
  try {
    const L = text.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter(Boolean), s = [];
    for (let i = 0; i < L.length; i++) if (L[i].startsWith('1 ') && L[i + 1]?.startsWith('2 ')) {
      const p = i > 0 && !L[i - 1].startsWith('1 ') && !L[i - 1].startsWith('2 ') ? L[i - 1] : '';
      s.push({ name: p.replace(/^0 /, '').trim() || `NORAD ${L[i].slice(2, 7).trim()}`, norad: parseInt(L[i].slice(2, 7), 10), l1: L[i], l2: L[i + 1] }); i++;
    }
    s.sort((a, b) => a.norad - b.norad || (a.l1 < b.l1 ? -1 : a.l1 > b.l1 ? 1 : a.l2 < b.l2 ? -1 : a.l2 > b.l2 ? 1 : 0));
    const buf = new TextEncoder().encode(s.map((x) => `${x.name}\n${x.l1}\n${x.l2}\n`).join(''));
    const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
    $('#skyhash').textContent = h;
    $('#skyhash-note').textContent = `sha256 of ${s.length.toLocaleString()} satellites · ${tleSource} · this is what a snapshot looks like. The real one is frozen at the committed second.`;
  } catch (e) { $('#skyhash').textContent = 'unavailable in this browser'; }
}

// ── provenance state ──
const C = CONFIG.COMMIT, R = CONFIG.REVEAL;
function field(k, v, cls) { const el = $(`[data-f="${k}"]`); if (!el) return; el.textContent = v; el.className = cls || ''; }
function link(k, href, text) { const el = $(`[data-f="${k}"]`); if (el) el.innerHTML = `<a href="${href}" target="_blank" rel="noopener">${text}</a>`; }
const committed = !!(C.SNAPSHOT_UTC && C.ENTROPY_COMMITMENT);
const revealed = !!(R.ENTROPY && R.SNAPSHOT_SHA256 && ca);
if (C.SNAPSHOT_UTC) field('snap-utc', new Date(C.SNAPSHOT_UTC).toISOString().replace('.000Z', 'Z'), 'ok');
if (C.ENTROPY_COMMITMENT) field('ent-commit', C.ENTROPY_COMMITMENT, 'ok hash');
if (C.RULES_SHA256) field('rules', C.RULES_SHA256, 'ok hash');
if (R.SATELLITES) field('snap-n', (+R.SATELLITES).toLocaleString(), 'ok');
if (R.SNAPSHOT_SHA256) field('snap-hash', R.SNAPSHOT_SHA256, 'ok hash');
if (R.SNAPSHOT_URL) link('snap-url', R.SNAPSHOT_URL, short(R.SNAPSHOT_URL, 18, 12));
if (ca) field('mint', ca, 'ok hash');
if (R.DECIDER_NORAD) field('decider', `${R.DECIDER_NAME || 'NORAD'} · #${R.DECIDER_NORAD}`, 'ok');
if (R.ENTROPY) field('entropy', R.ENTROPY, 'ok hash');
$('#st-commit').classList.toggle('done', committed);
$('#st-snapshot').classList.toggle('done', !!R.SNAPSHOT_SHA256);
$('#st-derive').classList.toggle('done', !!ca);
$('#st-prove').classList.toggle('done', revealed);
if (revealed) checkEntropy();
const status = revealed ? 'REVEALED · RECOMPUTE IT YOURSELF' : ca ? 'MINTED · REVEAL PENDING' : committed ? 'COMMITTED · SNAPSHOT PENDING' : 'COMMIT PENDING · CA DROPPING SOON';
$('#proof-status').innerHTML = `<i></i>${status}`; $('#proof-status').classList.toggle('ok', revealed);
async function checkEntropy() {
  try {
    const b = new Uint8Array(R.ENTROPY.match(/../g).map((h) => parseInt(h, 16)));
    const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const ok = C.ENTROPY_COMMITMENT && h === C.ENTROPY_COMMITMENT.toLowerCase();
    field('verified', ok ? 'sha256(entropy) = commitment ✓' : 'COMMITMENT MISMATCH ✗', ok ? 'ok' : 'bad');
  } catch { field('verified', '—'); }
}
function tickCountdown() {
  if (!C.SNAPSHOT_UTC) return;
  const d = Date.parse(C.SNAPSHOT_UTC) - Date.now();
  if (d <= 0) { field('countdown', 'SNAPSHOT TAKEN', 'ok'); return; }
  const s = Math.floor(d / 1000), p = (n) => String(n).padStart(2, '0');
  field('countdown', `T−${Math.floor(s / 86400)}d ${p(Math.floor(s / 3600) % 24)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`, 'ok');
}

// ── links + CA ──
const buy = (CONFIG.BUY_URL || '').trim() || (ca ? `https://pump.fun/coin/${ca}` : '');
for (const id of ['#btn-buy', '#btn-buy2']) {
  const b = $(id);
  if (buy) { b.href = buy; b.target = '_blank'; b.rel = 'noopener'; b.innerHTML = 'BUY $STAR'; }
  else b.classList.add('soon');
}
const xurl = (CONFIG.X_URL || '').trim();
$$('[data-x]').forEach((a) => {
  if (xurl) { a.href = xurl; a.target = '_blank'; a.rel = 'noopener'; const sp = a.querySelector('span'); if (sp) sp.textContent = 'FOLLOW'; }
  else { a.classList.add('soon'); a.removeAttribute('href'); a.title = 'X account coming soon'; const sp = a.querySelector('span'); if (sp) sp.textContent = 'SOON'; }
});
if (ca) {
  $('#ca-v').textContent = mobile ? short(ca, 6, 6) : ca; $('#ca-bar').classList.add('set');
  const cp = $('#ca-copy'); cp.hidden = false;
  cp.onclick = async () => { try { await navigator.clipboard.writeText(ca); cp.textContent = 'COPIED'; setTimeout(() => (cp.textContent = 'COPY'), 1600); } catch {} };
  $('#tok-ca').textContent = ca;
  $('#tok-ca-links').innerHTML = `<a href="https://solscan.io/token/${ca}" target="_blank" rel="noopener">SOLSCAN ↗</a> <a href="https://dexscreener.com/solana/${ca}" target="_blank" rel="noopener">DEXSCREENER ↗</a>`;
}

// ── live market data (DexScreener) + optional treasury balance (Solana RPC) ──
const fmtUSD = (v) => v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? '$' + (v / 1e3).toFixed(1) + 'K' : '$' + Math.round(v);
function fetchT(url, opts = {}, ms = 9000) { const c = new AbortController(), t = setTimeout(() => c.abort(), ms); return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t)); }
async function pollMcap() {
  if (!ca) { $('#tok-mc').textContent = '$0'; $('#tok-mc-s').textContent = 'PRE-LAUNCH'; return; }
  try {
    const r = await fetchT(CONFIG.DEXSCREENER + ca, {}, 8000); if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const best = (j.pairs || []).filter((p) => p.chainId === 'solana').map((p) => +(p.marketCap || p.fdv || 0)).filter((v) => v > 0).sort((a, b) => b - a)[0];
    if (best) { $('#tok-mc').textContent = fmtUSD(best); $('#tok-mc-s').innerHTML = '<i class="live"></i>LIVE · DEXSCREENER'; }
    else { $('#tok-mc').textContent = '—'; $('#tok-mc-s').textContent = 'AWAITING FIRST TRADE'; }
  } catch (e) { console.info('[mcap] unavailable:', e.message); $('#tok-mc-s').textContent = 'MARKET DATA UNAVAILABLE'; }
}
const RPCS = (CONFIG.RPC_URLS || []).filter(Boolean);
async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetchT(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error('no rpc');
}
async function pollTreasury() {
  const t = (CONFIG.TREASURY || '').trim(); if (!t) return;
  $('#tok-treasury').hidden = false;
  $('#tok-tre-addr').innerHTML = `<a href="https://solscan.io/account/${t}" target="_blank" rel="noopener">${short(t)} ↗</a>`;
  try { const r = await rpc('getBalance', [t, { commitment: 'confirmed' }]); $('#tok-tre-bal').textContent = (r.value / 1e9).toLocaleString(undefined, { maximumFractionDigits: 3 }) + ' SOL'; }
  catch (e) { $('#tok-tre-bal').textContent = '—'; console.info('[treasury] unavailable:', e.message); }
}
pollMcap(); pollTreasury();
setInterval(() => { if (!document.hidden) { pollMcap(); pollTreasury(); } }, CONFIG.POLL_SECONDS * 1000);

// ── scroll → camera + veil ──
const veil = $('.veil'), veil2 = $('.veil2');
function onScroll() {
  const k = Math.min(scrollY / innerHeight, 1.6);
  veil.style.opacity = Math.min(0.15 + k * 0.5, 0.72).toFixed(3);
  veil2.style.opacity = Math.min(Math.max((k - 0.35) * 0.9, 0), 0.62).toFixed(3);
  orbit && orbit.setScroll(Math.min(k, 1));
  document.body.classList.toggle('scrolled', scrollY > 40);
}
addEventListener('scroll', onScroll, { passive: true }); onScroll();

// reveal-on-scroll
const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add('in')), { threshold: 0.12 });
$$('section .wrap, .step, .foot .wrap').forEach((el) => { el.classList.add('rv'); io.observe(el); });
