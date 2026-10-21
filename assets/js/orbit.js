// STAR · live orbit renderer (Three.js). Earth in an Earth-fixed frame, Sun from UTC, satellites from SGP4 (worker).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DEG = Math.PI / 180;
// Low-precision solar position (≈0.01°) → unit vector in three.js Earth-fixed coords
function sunDir(ms) {
  const jd = ms / 86400000 + 2440587.5, n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * DEG, g = (357.528 + 0.9856003 * n) * DEG;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG, eps = (23.439 - 4e-7 * n) * DEG;
  const x = Math.cos(lam), y = Math.cos(eps) * Math.sin(lam), z = Math.sin(eps) * Math.sin(lam); // ECI
  const gm = ((280.46061837 + 360.98564736629 * n) % 360) * DEG;                                 // GMST
  const xe = x * Math.cos(gm) + y * Math.sin(gm), ye = -x * Math.sin(gm) + y * Math.cos(gm);     // ECI→ECF
  return new THREE.Vector3(xe, z, -ye).normalize();
}

const EARTH_VS = `varying vec2 vUv; varying vec3 vN; varying vec3 vW;
void main(){ vUv=uv; vN=normalize(mat3(modelMatrix)*normal); vec4 w=modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`;
const EARTH_FS = `uniform sampler2D uDay; uniform sampler2D uNight; uniform sampler2D uSpec; uniform vec3 uSun; uniform float uHasTex;
varying vec2 vUv; varying vec3 vN; varying vec3 vW;
void main(){
  vec3 n=normalize(vN); vec3 v=normalize(cameraPosition-vW); float l=dot(n,uSun);
  vec3 day = uHasTex>.5 ? texture2D(uDay,vUv).rgb : mix(vec3(.02,.06,.16),vec3(.05,.12,.08),step(.5,fract(vUv.x*7.)*fract(vUv.y*5.)));
  vec3 night = uHasTex>.5 ? texture2D(uNight,vUv).rgb : vec3(0.);
  float spec = uHasTex>.5 ? texture2D(uSpec,vUv).r : .5;
  float dl = smoothstep(-.12,.25,l);
  vec3 col = day*(max(l,0.)*1.25+.015);
  col += night*vec3(1.,.72,.42)*1.9*(1.-dl);
  vec3 h=normalize(uSun+v); col += vec3(1.,.95,.85)*pow(max(dot(n,h),0.),48.)*spec*.28*dl;
  float fr=pow(1.-max(dot(n,v),0.),3.);
  col += vec3(.25,.5,1.)*fr*(.12+.9*smoothstep(-.35,.6,l));
  col += vec3(1.,.45,.2)*fr*.35*(1.-abs(l*3.))*step(-.33,l)*step(l,.33);
  gl_FragColor=vec4(col,1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const CLOUD_FS = `uniform sampler2D uC; uniform vec3 uSun; varying vec2 vUv; varying vec3 vN; varying vec3 vW;
void main(){ vec3 n=normalize(vN); float l=dot(n,uSun); float a=texture2D(uC,vUv).r;
  gl_FragColor=vec4(vec3(1.)*(max(l,0.)*.95+.02), a*.5*smoothstep(-.25,.1,l)+a*.04);
  #include <colorspace_fragment>
}`;
const ATM_VS = `varying vec3 vN; varying vec3 vW; void main(){ vN=normalize(mat3(modelMatrix)*normal); vec4 w=modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`;
const ATM_FS = `uniform vec3 uSun; varying vec3 vN; varying vec3 vW;
void main(){ vec3 n=normalize(vN); vec3 v=normalize(cameraPosition-vW);
  float rim=pow(clamp(1.-abs(dot(n,v)),0.,1.),2.2); float lit=smoothstep(-.45,.55,dot(n,uSun));
  vec3 c=mix(vec3(.18,.12,.5),vec3(.28,.62,1.),lit);
  float a=smoothstep(0.,1.,rim)*(.25+.95*lit);
  gl_FragColor=vec4(c*a*1.4,a);
}`;
const SAT_VS = `attribute vec3 posA; attribute vec3 posB; attribute float aSeed;
uniform float uMix; uniform float uRef; uniform vec3 uSun; uniform float uSize; uniform float uPR; uniform float uTime;
varying float vLit; varying float vTw;
void main(){
  vec3 p=mix(posA,posB,uMix);
  float d=dot(p,uSun); float perp=length(p-d*uSun);
  vLit = (d>0. || perp>1.0) ? 1. : 0.;
  vTw = .75+.25*sin(uTime*2.3+aSeed*40.);
  vec4 mv=modelViewMatrix*vec4(p,1.);
  gl_PointSize = uSize*uPR*(vLit>.5?1.:.8)*(uRef/-mv.z);
  if(dot(p,p)<.01) gl_PointSize=0.;
  gl_Position=projectionMatrix*mv;
}`;
const SAT_FS = `varying float vLit; varying float vTw;
void main(){ vec2 c=gl_PointCoord-.5; float r=length(c); if(r>.5) discard;
  float core=smoothstep(.5,.0,r); core=core*(.35+.65*core)+smoothstep(.18,0.,r)*.6;
  vec3 lit=vec3(.8,.92,1.)*1.5*vTw; vec3 dark=vec3(.5,.42,1.)*.5;
  vec3 col=mix(dark,lit,vLit);
  gl_FragColor=vec4(col*core, core);
}`;
const MARK_VS = `uniform float uPR; uniform float uTime; varying float vT; void main(){ vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=(40.+6.*sin(uTime*3.))*uPR; gl_Position=projectionMatrix*mv; }`;
const MARK_FS = `uniform vec3 uCol; uniform float uTime; void main(){ vec2 c=gl_PointCoord-.5; float r=length(c)*2.;
  float ring=smoothstep(.06,.0,abs(r-.78))*.9; float dot_=smoothstep(.22,.0,r); float halo=smoothstep(1.,.0,r)*.18;
  float ticks = step(.9,abs(c.x)*2.)*step(abs(c.y),.02)+step(.9,abs(c.y)*2.)*step(abs(c.x),.02);
  float a=ring+dot_+halo+ticks*.8; if(a<.01) discard; gl_FragColor=vec4(uCol*a,a); }`;
const RING_VS = `attribute float aT; varying float vT; void main(){ vT=aT; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`;
const RING_FS = `uniform vec3 uCol; uniform float uA; varying float vT; void main(){ float a=pow(vT,2.2)*uA; gl_FragColor=vec4(uCol*a,a); }`;

export function createOrbit({ canvas, max, keep = [], onProgress = () => {}, onFirstFrame = () => {}, onSelect = () => {}, onDetail = () => {} }) {
  const mobile = matchMedia('(max-width: 760px), (pointer: coarse)').matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, alpha: true, powerPreference: 'high-performance' });
  const PR = Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2);
  renderer.setPixelRatio(PR);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 400);
  const controls = new OrbitControls(camera, canvas);
  controls.enableZoom = false; controls.enablePan = false; controls.enableDamping = true; controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.45; controls.autoRotate = true; controls.autoRotateSpeed = 0.22;
  controls.minPolarAngle = 0.25; controls.maxPolarAngle = Math.PI - 0.25;
  if (mobile) controls.enableRotate = false;

  // camera start: looking at Europe/Atlantic-ish from slightly north
  const camDist = mobile ? 8.6 : 5.0;
  const sun = sunDir(Date.now());
  // start looking at the terminator: day on one side, city lights on the other
  { const d = sun.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 1.15); d.y = 0.32; camera.position.copy(d.normalize().multiplyScalar(camDist)); }
  const uSun = { value: sun };

  // stars
  {
    const N = mobile ? 2200 : 4200, p = new Float32Array(N * 3), c = new Float32Array(N * 3), s = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = 80 + Math.random() * 40, q = Math.sqrt(1 - u * u);
      p.set([r * q * Math.cos(th), r * u, r * q * Math.sin(th)], i * 3);
      const t = Math.random(); c.set(t < .15 ? [1, .85, .7] : t < .35 ? [.7, .8, 1] : [1, 1, 1], i * 3);
      s[i] = Math.pow(Math.random(), 6) * 3.2 + 0.6;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); g.setAttribute('aS', new THREE.BufferAttribute(s, 1));
    const m = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uPR: { value: PR } },
      vertexShader: `attribute float aS; varying vec3 vC; uniform float uPR; void main(){ vC=color; gl_PointSize=aS*uPR; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `varying vec3 vC; void main(){ float r=length(gl_PointCoord-.5); if(r>.5) discard; float a=smoothstep(.5,0.,r); gl_FragColor=vec4(vC*a*.9,a); }`, vertexColors: true });
    scene.add(new THREE.Points(g, m));
  }

  // earth
  const loader = new THREE.TextureLoader();
  let texLoaded = 0; const texTotal = 4;
  const tex = (url) => loader.load(url, (t) => { texLoaded++; onProgress('tex', texLoaded / texTotal); }, undefined, () => { texLoaded++; onProgress('tex', texLoaded / texTotal); });
  const base = new URL('../img/', import.meta.url).href;
  const tDay = tex(base + 'earth_atmos_2048.jpg'), tNight = tex(base + 'earth_lights_2048.png'), tSpec = tex(base + 'earth_specular_2048.jpg'), tCloud = tex(base + 'earth_clouds_1024.jpg');
  tDay.colorSpace = THREE.SRGBColorSpace; tNight.colorSpace = THREE.SRGBColorSpace;
  for (const t of [tDay, tNight, tSpec, tCloud]) t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const seg = mobile ? 96 : 160;
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, seg, seg / 2), new THREE.ShaderMaterial({
    uniforms: { uDay: { value: tDay }, uNight: { value: tNight }, uSpec: { value: tSpec }, uSun, uHasTex: { value: 1 } }, vertexShader: EARTH_VS, fragmentShader: EARTH_FS }));
  scene.add(earth);
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.007, seg, seg / 2), new THREE.ShaderMaterial({
    uniforms: { uC: { value: tCloud }, uSun }, vertexShader: EARTH_VS, fragmentShader: CLOUD_FS, transparent: true, depthWrite: false }));
  scene.add(clouds);
  const atm = new THREE.Mesh(new THREE.SphereGeometry(1.11, 96, 48), new THREE.ShaderMaterial({
    uniforms: { uSun }, vertexShader: ATM_VS, fragmentShader: ATM_FS, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(atm);

  // satellites
  let sats = null, satGeo = null, satMat = null, meta = [], N = 0;
  let posA = null, posB = null, tA = 0, tB = 0, queued = null;
  const marker = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)),
    new THREE.ShaderMaterial({ uniforms: { uPR: { value: PR }, uTime: { value: 0 }, uCol: { value: new THREE.Color(0x8fd0ff) } }, vertexShader: MARK_VS, fragmentShader: MARK_FS, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending }));
  marker.frustumCulled = false; marker.visible = false; scene.add(marker);
  const ringGeo = new THREE.BufferGeometry();
  { const at = new Float32Array(161); for (let k = 0; k <= 160; k++) at[k] = k / 160; ringGeo.setAttribute('aT', new THREE.BufferAttribute(at, 1)); ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(161 * 3), 3)); }
  const ring = new THREE.Line(ringGeo, new THREE.ShaderMaterial({ uniforms: { uCol: { value: new THREE.Color(0x7fbfff) }, uA: { value: 0.85 } }, vertexShader: RING_VS, fragmentShader: RING_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  ring.frustumCulled = false; ring.visible = false; scene.add(ring);

  // time
  let warp = 1, simT = Date.now(), gen = 0, reqId = 0, inflight = false, selected = -1, detailReq = 0, lastDetail = 0;
  const stepFor = (w) => Math.min(Math.max(w * 1000, 1000), 30000); // sim ms between SGP4 keyframes
  const worker = new Worker(new URL('./sgp4-worker.js', import.meta.url));
  let firstFrameDone = false, ready = false;

  function request(t) { inflight = true; worker.postMessage({ type: 'prop', t, id: ++reqId, gen }); return reqId; }
  let pending = {}; // id → {t, gen}
  function want(t) { const id = request(t); pending[id] = { t, gen }; }

  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'ready') {
      meta = m.meta; N = meta.length;
      satGeo = new THREE.BufferGeometry();
      posA = new Float32Array(N * 3); posB = new Float32Array(N * 3);
      const seed = new Float32Array(N); for (let i = 0; i < N; i++) seed[i] = Math.random();
      satGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      satGeo.setAttribute('posA', new THREE.BufferAttribute(posA, 3)); satGeo.setAttribute('posB', new THREE.BufferAttribute(posB, 3));
      satGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      satGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
      satMat = new THREE.ShaderMaterial({ uniforms: { uMix: { value: 0 }, uSun, uSize: { value: mobile ? 3.4 : 3.6 }, uRef: { value: camDist }, uPR: { value: PR }, uTime: { value: 0 } },
        vertexShader: SAT_VS, fragmentShader: SAT_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      sats = new THREE.Points(satGeo, satMat); sats.frustumCulled = false; scene.add(sats);
      api.info = { total: m.total, rendered: N, sampled: m.sampled, epochNewest: m.epochNewest, epochMedian: m.epochMedian, meta };
      onProgress('sats', 1, api.info);
      resetKeys();
      return;
    }
    if (m.type === 'pos') {
      const p = pending[m.id]; delete pending[m.id]; inflight = false;
      if (!p || p.gen !== gen) return;
      if (!ready) {
        if (!tA) { posA.set(m.pos); tA = m.t; }
        else { posB.set(m.pos); tB = m.t; ready = true; }
        satGeo.attributes.posA.needsUpdate = true; satGeo.attributes.posB.needsUpdate = true;
      } else queued = m;
      return;
    }
    if (m.type === 'detail' && m.i === selected) {
      ringGeo.attributes.position.array.set(m.ring); ringGeo.attributes.position.needsUpdate = true; ring.visible = true;
      onDetail({ ...meta[m.i], lat: m.lat, lon: m.lon, alt: m.alt, vel: m.vel, periodMin: m.periodMin, lit: satLit(m.i) });
    }
  };
  function resetKeys() { gen++; pending = {}; ready = false; tA = 0; tB = 0; queued = null; const s = stepFor(warp); want(simT); want(simT + s); }

  function curPos(i, out) {
    const k = i * 3, f = satMat ? satMat.uniforms.uMix.value : 0;
    return out.set(posA[k] + (posB[k] - posA[k]) * f, posA[k + 1] + (posB[k + 1] - posA[k + 1]) * f, posA[k + 2] + (posB[k + 2] - posA[k + 2]) * f);
  }
  const _v = new THREE.Vector3();
  function satLit(i) { curPos(i, _v); const d = _v.dot(uSun.value); return d > 0 || _v.clone().addScaledVector(uSun.value, -d).length() > 1; }

  function select(i, why = 'auto') {
    if (i < 0 || i >= N) return; selected = i; marker.visible = true; ring.visible = false; lastDetail = 0;
    onSelect({ ...meta[i], index: i, why });
  }

  // picking
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || !ready) return; const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
    if (moved > 6) return;
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = -1, bd = (mobile ? 22 : 14) ** 2; const cp = camera.position, p = new THREE.Vector3(), s = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      curPos(i, p); if (p.lengthSq() < 0.01) continue;
      // occlusion: ray cam→p hits unit sphere before p?
      const d = p.clone().sub(cp), L = d.length(); d.divideScalar(L);
      const b = cp.dot(d), c = cp.lengthSq() - 1, disc = b * b - c;
      if (disc > 0) { const t0 = -b - Math.sqrt(disc); if (t0 > 0 && t0 < L) continue; }
      s.copy(p).project(camera); if (s.z > 1) continue;
      const sx = (s.x * .5 + .5) * r.width, sy = (-s.y * .5 + .5) * r.height, dd = (sx - mx) ** 2 + (sy - my) ** 2;
      if (dd < bd) { bd = dd; best = i; }
    }
    if (best >= 0) select(best, 'user');
  });

  // layout
  let offsetX = 0;
  function resize() {
    const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false);
    camera.aspect = w / h;
    offsetX = w > 900 ? -w * 0.19 : 0;
    const offY = w > 900 ? 0 : h * 0.13;
    camera.setViewOffset(w, h, offsetX, offY, w, h);
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize); resize();

  let scrollK = 0;
  const clock = new THREE.Clock();
  let raf = 0, visible = true;
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; if (visible) { clock.getDelta(); loop(); } });
  const label = { el: null };
  function loop() {
    if (!visible) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
    simT += dt * 1000 * warp;
    if (ready) {
      if (simT >= tB && queued) { // advance keyframes
        posA.set(posB); tA = tB; posB.set(queued.pos); tB = queued.t; queued = null;
        satGeo.attributes.posA.needsUpdate = true; satGeo.attributes.posB.needsUpdate = true;
      }
      if (!queued && !inflight && simT > tA) want(tB + stepFor(warp));
      satMat.uniforms.uMix.value = Math.min(Math.max((simT - tA) / (tB - tA), 0), 1);
      satMat.uniforms.uTime.value = t;
      if (selected >= 0) {
        curPos(selected, _v); marker.geometry.attributes.position.array.set([_v.x, _v.y, _v.z]); marker.geometry.attributes.position.needsUpdate = true;
        marker.material.uniforms.uTime.value = t;
        if (performance.now() - lastDetail > 900) { lastDetail = performance.now(); worker.postMessage({ type: 'detail', i: selected, t: simT, req: ++detailReq }); }
        if (api.onLabel) { const s = _v.clone().project(camera); const r = canvas.getBoundingClientRect();
          const d = _v.clone().sub(camera.position), L = d.length(); d.divideScalar(L); const b = camera.position.dot(d), c = camera.position.lengthSq() - 1, disc = b * b - c;
          const hidden = disc > 0 && (-b - Math.sqrt(disc)) > 0 && (-b - Math.sqrt(disc)) < L;
          api.onLabel((s.x * .5 + .5) * r.width, (-s.y * .5 + .5) * r.height, hidden || s.z > 1); }
      }
      if (!firstFrameDone) { firstFrameDone = true; requestAnimationFrame(() => onFirstFrame()); }
    }
    uSun.value.copy(sunDir(simT));
    clouds.rotation.y = t * 0.004;
    // scroll: pull back + drift
    const target = camDist * (1 + scrollK * 0.55);
    const L = camera.position.length(); camera.position.multiplyScalar(1 + (target - L) / L * 0.08);
    controls.update(dt);
    renderer.render(scene, camera);
  }
  loop();

  const api = {
    info: null,
    load(text) { worker.postMessage({ type: 'init', text, max, keep, t: simT }); },
    setWarp(w) { warp = w; resetKeys(); },
    select, selectNorad(id) { const i = meta.findIndex((m) => m.norad === +id); if (i >= 0) select(i, 'decider'); return i; },
    get selected() { return selected; }, get N() { return N; }, get simT() { return simT; },
    setScroll(k) { scrollK = k; },
    setAutoRotate(on) { controls.autoRotate = on; },
    onLabel: null,
  };
  return api;
}
