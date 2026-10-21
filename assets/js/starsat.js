// STAR · procedural high-detail satellite (flat-panel bus + two long solar wings). Generic design, no logos.
// Units: metres (caller scales to km). Local axes: x = wing axis (cross-track), y = zenith, z = along-track.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const rand = (() => { let s = 1337; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d', { willReadFrequently: true })]; }

// height canvas → tangent-space normal map
function normalFromHeight(hc, strength = 2) {
  const w = hc.width, h = hc.height, src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const [nc, ng] = canvas(w, h), out = ng.createImageData(w, h), o = out.data;
  const H = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1), k = (y * w + x) * 4;
    o[k] = (-dx / l * .5 + .5) * 255; o[k + 1] = (dy / l * .5 + .5) * 255; o[k + 2] = (1 / l * .5 + .5) * 255; o[k + 3] = 255;
  }
  ng.putImageData(out, 0, 0); return nc;
}
function tex(c, srgb, rep = [1, 1]) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep[0], rep[1]); t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t;
}

// ── solar cell panel: colour, height(normal), roughness ──
function cellMaps(q) {
  const W = q, Hh = q / 2, CX = 8, CY = 4;              // 8×4 cells per texture tile
  const [cc, cg] = canvas(W, Hh), [hc, hg] = canvas(W, Hh), [rc, rg] = canvas(W, Hh);
  cg.fillStyle = '#b9bcc6'; cg.fillRect(0, 0, W, Hh);   // substrate visible in gaps
  hg.fillStyle = '#000'; hg.fillRect(0, 0, W, Hh);
  rg.fillStyle = 'rgb(0,190,0)'; rg.fillRect(0, 0, W, Hh);
  const cw = W / CX, ch = Hh / CY, gap = Math.max(1.5, W / 512), cham = cw * 0.12;
  for (let i = 0; i < CX; i++) for (let j = 0; j < CY; j++) {
    const x = i * cw + gap, y = j * ch + gap, w = cw - 2 * gap, h = ch - 2 * gap;
    const path = (g) => { g.beginPath(); g.moveTo(x + cham, y); g.lineTo(x + w - cham, y); g.lineTo(x + w, y + cham); g.lineTo(x + w, y + h - cham); g.lineTo(x + w - cham, y + h); g.lineTo(x + cham, y + h); g.lineTo(x, y + h - cham); g.lineTo(x, y + cham); g.closePath(); };
    const k = rand() * 10;
    const gr = cg.createLinearGradient(x, y, x + w, y + h); gr.addColorStop(0, `rgb(${14 + k},${26 + k},${84 + k * 2})`); gr.addColorStop(1, `rgb(${6 + k},${12 + k},${44 + k * 2})`);
    path(cg); cg.fillStyle = gr; cg.fill();
    path(hg); hg.fillStyle = '#a0a0a0'; hg.fill();
    path(rg); rg.fillStyle = 'rgb(0,40,0)'; rg.fill();
    // fingers + bus bars
    cg.fillStyle = 'rgba(160,180,220,.12)'; for (let f = 1; f < 18; f++) cg.fillRect(x, y + (h * f) / 18, w, Math.max(0.6, W / 2048));
    for (const bx of [0.28, 0.72]) {
      const xx = x + w * bx; cg.fillStyle = '#d7dbe6'; cg.fillRect(xx - W / 1024, y, W / 512, h);
      hg.fillStyle = '#ffffff'; hg.fillRect(xx - W / 1024, y, W / 512, h);
      rg.fillStyle = 'rgb(0,90,0)'; rg.fillRect(xx - W / 1024, y, W / 512, h);
    }
  }
  return { map: tex(cc, true), normalMap: tex(normalFromHeight(hc, 3), false), roughnessMap: tex(rc, false) };
}
// panel back: white kapton with a grid of ribs
function backMaps(q) {
  const [c, g] = canvas(q / 2, q / 4); g.fillStyle = '#d9dade'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(120,125,140,.5)'; g.lineWidth = 1; for (let x = 0; x < c.width; x += c.width / 8) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, c.height); g.stroke(); }
  for (let y = 0; y < c.height; y += c.height / 4) { g.beginPath(); g.moveTo(0, y); g.lineTo(c.width, y); g.stroke(); }
  return { map: tex(c, true) };
}
// crinkled MLI foil
function foilMaps(q) {
  const [hc, hg] = canvas(q, q); hg.fillStyle = '#808080'; hg.fillRect(0, 0, q, q);
  for (let i = 0; i < 900; i++) {
    const x = rand() * q, y = rand() * q, r = (0.02 + rand() * 0.09) * q, a = rand() * 6.28;
    const v = rand() > .5 ? 255 : 0; hg.fillStyle = `rgba(${v},${v},${v},${0.05 + rand() * 0.08})`;
    hg.beginPath(); hg.moveTo(x, y); for (let k = 0; k < 5; k++) { const aa = a + k * 1.256 + rand() * .6, rr = r * (0.4 + rand()); hg.lineTo(x + Math.cos(aa) * rr, y + Math.sin(aa) * rr); } hg.closePath(); hg.fill();
  }
  hg.filter = 'blur(1px)'; hg.drawImage(hc, 0, 0); hg.filter = 'none';
  const [rc, rg] = canvas(q / 2, q / 2); const id = rg.createImageData(q / 2, q / 2); for (let k = 0; k < id.data.length; k += 4) { const v = 60 + rand() * 70; id.data[k + 1] = v; id.data[k + 3] = 255; } rg.putImageData(id, 0, 0);
  return { normalMap: tex(normalFromHeight(hc, 6), false, [2, 2]), roughnessMap: tex(rc, false, [2, 2]) };
}
// brushed metal roughness streaks
function brushedMaps(q) {
  const [c, g] = canvas(q, q / 4); g.fillStyle = 'rgb(0,110,0)'; g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(0,${60 + rand() * 120},0,.35)`; g.fillRect(0, rand() * c.height, c.width, 0.6 + rand()); }
  return { roughnessMap: tex(c, false) };
}
// phased-array face: tiles of radiating elements
function arrayMaps(q) {
  const [c, g] = canvas(q, q), [hc, hg] = canvas(q, q);
  g.fillStyle = '#c7cad1'; g.fillRect(0, 0, q, q); hg.fillStyle = '#404040'; hg.fillRect(0, 0, q, q);
  const tiles = 4, ts = q / tiles;
  for (let i = 0; i < tiles; i++) for (let j = 0; j < tiles; j++) {
    const x = i * ts, y = j * ts;
    g.fillStyle = '#aeb2bb'; g.fillRect(x + 3, y + 3, ts - 6, ts - 6); hg.fillStyle = '#909090'; hg.fillRect(x + 3, y + 3, ts - 6, ts - 6);
    const n = 9, s = (ts - 12) / n;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      const cx = x + 6 + s * (a + .5), cy = y + 6 + s * (b + .5);
      g.fillStyle = '#9aa0ab'; g.beginPath(); g.arc(cx, cy, s * .32, 0, 6.283); g.fill();
      hg.fillStyle = '#d0d0d0'; hg.beginPath(); hg.arc(cx, cy, s * .32, 0, 6.283); hg.fill();
    }
  }
  return { map: tex(c, true), normalMap: tex(normalFromHeight(hc, 2.5), false) };
}

export function makeSatKit(quality = 'high') {
  const q = quality === 'high' ? 2048 : 1024;
  const cells = cellMaps(q), back = backMaps(q), foil = foilMaps(quality === 'high' ? 512 : 256), brushed = brushedMaps(512), arr = arrayMaps(quality === 'high' ? 1024 : 512);
  const M = {
    cells: new THREE.MeshPhysicalMaterial({ ...cells, color: 0x9aa8c8, metalness: 0.0, roughness: 1, normalScale: new THREE.Vector2(0.9, 0.9), specularIntensity: 0.12,
      clearcoat: 0.12, clearcoatRoughness: 0.18, iridescence: quality === 'high' ? 0.12 : 0, iridescenceIOR: 1.55, iridescenceThicknessRange: [180, 520], envMapIntensity: 0.12 }),
    back: new THREE.MeshPhysicalMaterial({ ...back, roughness: 0.8, metalness: 0, envMapIntensity: 0.5, sheen: 0.25, sheenColor: new THREE.Color(0x9fb0d0) }),
    frame: new THREE.MeshPhysicalMaterial({ color: 0xc4c8d0, metalness: 1, roughness: 0.28, ...brushed, anisotropy: 0.7 }),
    chassis: new THREE.MeshPhysicalMaterial({ color: 0xb4b9c3, metalness: 1, roughness: 0.34, ...brushed, anisotropy: 0.8, clearcoat: 0.3, clearcoatRoughness: 0.25 }),
    gold: new THREE.MeshPhysicalMaterial({ color: 0xd9a74a, metalness: 1, roughness: 0.32, ...foil, normalScale: new THREE.Vector2(1.1, 1.1) }),
    silver: new THREE.MeshPhysicalMaterial({ color: 0xe3e6ec, metalness: 1, roughness: 0.22, ...foil, normalScale: new THREE.Vector2(0.9, 0.9) }),
    array: new THREE.MeshPhysicalMaterial({ ...arr, color: 0xffffff, metalness: 0.1, roughness: 0.55, clearcoat: 0.2 }),
    dark: new THREE.MeshPhysicalMaterial({ color: 0x23262d, metalness: 0.6, roughness: 0.4 }),
    lens: new THREE.MeshPhysicalMaterial({ color: 0x0a0d18, metalness: 0, roughness: 0.02, clearcoat: 1, transmission: 0, iridescence: 0.8, iridescenceIOR: 1.8 }),
  };
  return { M, q };
}

// detailed model. Returns { group, wings:[pivot,pivot], wingGlintLocal:[Vector3,Vector3] }
export function buildSatellite(kit) {
  const { M } = kit, g = new THREE.Group();
  const CH = { x: 2.9, y: 0.34, z: 4.1 };
  // chassis with bevels
  const ch = new THREE.Mesh(new RoundedBoxGeometry(CH.x, CH.y, CH.z, 6, 0.06), M.chassis); g.add(ch);
  // zenith MLI blankets (gold + silver patches)
  const top = new THREE.Mesh(new RoundedBoxGeometry(CH.x - 0.2, 0.02, CH.z * 0.62, 3, 0.008), M.gold); top.position.set(0, CH.y / 2 + 0.01, -CH.z * 0.16); g.add(top);
  const top2 = new THREE.Mesh(new RoundedBoxGeometry(CH.x - 0.2, 0.02, CH.z * 0.3, 3, 0.008), M.silver); top2.position.set(0, CH.y / 2 + 0.01, CH.z * 0.33); g.add(top2);
  // nadir phased-array face (4 panels)
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const p = new THREE.Mesh(new RoundedBoxGeometry(CH.x / 2 - 0.1, 0.03, CH.z / 2 - 0.12, 2, 0.01), M.array);
    p.position.set((i - .5) * CH.x / 2, -CH.y / 2 - 0.012, (j - .5) * CH.z / 2); g.add(p);
  }
  // side details: star trackers, laser terminals, thruster
  const cyl = (r, h, m, seg = 32) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m);
  for (const sx of [-1, 1]) {
    const st = cyl(0.09, 0.22, M.dark); st.position.set(sx * 0.9, CH.y / 2 + 0.13, CH.z * 0.42); g.add(st);
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.075, 24, 12, 0, 6.283, 0, 1.2), M.lens); lens.position.set(sx * 0.9, CH.y / 2 + 0.24, CH.z * 0.42); g.add(lens);
    const lt = new THREE.Mesh(new THREE.SphereGeometry(0.16, 32, 16, 0, 6.283, 0, 1.6), M.silver); lt.position.set(sx * 1.1, -CH.y / 2, -CH.z * 0.47); lt.rotation.x = Math.PI; g.add(lt);
  }
  const noz = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.26, 32, 1, true), M.dark); noz.position.set(0, 0, -CH.z / 2 - 0.12); noz.rotation.x = -Math.PI / 2; g.add(noz);
  // wings
  const wings = [], glints = [];
  const PANELS = 6, PL = 2.05, PW = 3.3, GAP = 0.07, ROOT = CH.x / 2 + 1.25;
  for (const s of [-1, 1]) {
    // boom + hinge yoke
    const boom = cyl(0.045, 1.25, M.frame, 24); boom.rotation.z = Math.PI / 2; boom.position.set(s * (CH.x / 2 + 0.62), 0, 0); g.add(boom);
    const hinge = cyl(0.085, 0.3, M.dark, 32); hinge.rotation.x = Math.PI / 2; hinge.position.set(s * (CH.x / 2 + 0.05), 0, 0); g.add(hinge);
    const pivot = new THREE.Group(); pivot.position.set(s * ROOT, 0, 0); g.add(pivot);
    const yoke = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.06, PW * 0.9, 2, 0.02), M.frame); pivot.add(yoke);
    for (let k = 0; k < PANELS; k++) {
      const cx = s * (0.12 + PL / 2 + k * (PL + GAP));
      const geo = new THREE.BoxGeometry(PL, 0.028, PW);
      // box groups: +x,-x,+y,-y,+z,-z
      const panel = new THREE.Mesh(geo, [M.frame, M.frame, M.cells, M.back, M.frame, M.frame]); panel.position.x = cx; pivot.add(panel);
      // edge frames
      for (const ez of [-1, 1]) { const f = new THREE.Mesh(new THREE.BoxGeometry(PL, 0.04, 0.035), M.frame); f.position.set(cx, 0, ez * (PW / 2 + 0.012)); pivot.add(f); }
      for (const ex of [-1, 1]) { const f = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, PW + 0.05), M.frame); f.position.set(cx + ex * (PL / 2 + 0.008), 0, 0); pivot.add(f); }
      if (k < PANELS - 1) for (const hz of [-0.33, 0.33]) { const h = cyl(0.022, 0.16, M.dark, 16); h.rotation.z = Math.PI / 2; h.position.set(cx + s * (PL / 2 + GAP / 2), 0, hz * PW); pivot.add(h); }
    }
    wings.push(pivot); glints.push(new THREE.Vector3(s * (ROOT + 0.12 + (PANELS * (PL + GAP)) * 0.45), 0, 0));
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return { group: g, wings, glintLocal: glints, span: 2 * (ROOT + 0.12 + PANELS * (PL + GAP)) };
}

// cheap LOD for neighbours (instanced): chassis + 2 wings as merged simple boxes
export function lodGeometries() {
  const body = new THREE.BoxGeometry(2.9, 0.34, 4.1);
  const wingL = new THREE.BoxGeometry(12.7, 0.03, 3.3).translate(-(1.45 + 1.25 + 6.45), 0, 0);
  const wingR = new THREE.BoxGeometry(12.7, 0.03, 3.3).translate(1.45 + 1.25 + 6.45, 0, 0);
  return { body, wingL, wingR };
}
