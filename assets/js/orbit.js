// STAR · IN-SHELL renderer. The camera rides inside the Starlink shell (~550 km) next to a real satellite.
// Far field: every satellite, SGP4 keyframes from a worker, interpolated on the GPU (camera-relative, km).
// Near field: the K nearest real satellites, propagated precisely on the main thread every frame and drawn
// as low-poly panel+wing bodies with sun glints, streaks and orbit rails. Units: km, Earth-fixed frame.
import * as THREE from 'three';

const DEG = Math.PI / 180, RE = 6371.0;
let SAT = null; // satellite.js (ESM) for the near field
async function loadSat() {
  try { SAT = await import('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.es.js'); }
  catch { SAT = await import(new URL('../vendor/satellite.es.js', import.meta.url).href); }
}
const satReady = loadSat();

function gmstOf(ms) { const n = ms / 86400000 + 2440587.5 - 2451545.0; return (((280.46061837 + 360.98564736629 * n) % 360) + 360) % 360 * DEG; }
function sunDir(ms) {
  const n = ms / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * DEG, g = (357.528 + 0.9856003 * n) * DEG;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG, eps = (23.439 - 4e-7 * n) * DEG;
  const x = Math.cos(lam), y = Math.cos(eps) * Math.sin(lam), z = Math.sin(eps) * Math.sin(lam), gm = gmstOf(ms);
  const xe = x * Math.cos(gm) + y * Math.sin(gm), ye = -x * Math.sin(gm) + y * Math.cos(gm);
  return new THREE.Vector3(xe, z, -ye).normalize();
}
const radec = (ra, dec) => { const a = ra * DEG, d = dec * DEG; const x = Math.cos(d) * Math.cos(a), y = Math.cos(d) * Math.sin(a), z = Math.sin(d); return new THREE.Vector3(x, z, -y); };

// ── shaders ──
const NOISE = `
float h3(vec3 p){ p=fract(p*.3183099+.1); p*=17.; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vn(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.-2.*f);
  return mix(mix(mix(h3(i),h3(i+vec3(1,0,0)),f.x),mix(h3(i+vec3(0,1,0)),h3(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(h3(i+vec3(0,0,1)),h3(i+vec3(1,0,1)),f.x),mix(h3(i+vec3(0,1,1)),h3(i+vec3(1,1,1)),f.x),f.y),f.z); }
float fbm(vec3 p){ float a=.5,s=0.; for(int i=0;i<OCT;i++){ s+=a*vn(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=.5; } return s; }`;
const SKY_VS = `varying vec3 vD; void main(){ vD=position; vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.); gl_Position=p.xyww; }`;
const SKY_FS = `uniform vec3 uGNP; uniform vec3 uGC; varying vec3 vD; ${NOISE}
void main(){ vec3 d=normalize(vD);
  float b=dot(d,uGNP);
  float n1=fbm(d*3.2), n2=fbm(d*9.+n1*1.5), n3=fbm(d*1.6+4.);
  float band=exp(-b*b*22.)*(.55+.9*n1);
  float lanes=smoothstep(.42,.72,fbm(d*6.5+vec3(3.))) * exp(-b*b*60.);
  float bulge=exp(-dot(d-uGC,d-uGC)*2.6);
  vec3 col=vec3(.30,.40,.95)*band*.085 + vec3(.80,.72,.95)*bulge*.06*(.6+n2*.6);
  col*= (1.-lanes*.75);
  col+= vec3(.03,.04,.06)*pow(n2,3.)*band*2.;
  // violet / blue nebula clouds (logo art palette)
  float neb=smoothstep(.52,.85,n3);
  col+= mix(vec3(.30,.16,.70),vec3(.10,.22,.70),fbm(d*2.4))*neb*.085;
  gl_FragColor=vec4(col,1.);
  #include <colorspace_fragment>
}`;
const STAR_VS = `attribute float aS; attribute vec3 aC; varying vec3 vC; varying float vT; uniform float uPR; uniform float uTime;
void main(){ vC=aC; vT=.8+.2*sin(uTime*(1.+fract(aS*13.)*2.)+aS*50.); vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.); gl_Position=p.xyww; gl_PointSize=aS*uPR; }`;
const STAR_FS = `varying vec3 vC; varying float vT; void main(){ float r=length(gl_PointCoord-.5); if(r>.5) discard; float a=smoothstep(.5,0.,r); a*=a; gl_FragColor=vec4(vC*a*vT,1.); }`;

const FAR_VS = `attribute vec3 posA; attribute vec3 posB; attribute float aSeed; attribute float aHide;
uniform float uMix; uniform vec3 uCam; uniform vec3 uSun; uniform float uPR; uniform float uTime; uniform float uA;
varying float vB; varying vec3 vCol;
void main(){
  vec3 w=mix(posA,posB,uMix); vec3 p=w-uCam; float d=length(p);
  float sd=dot(w,uSun); bool lit = sd>0. || length(w-sd*uSun)>${RE.toFixed(1)};
  // occluded by Earth?
  vec3 E=-uCam; vec3 dir=p/max(d,1e-3); float t=dot(E,dir); float occ = (t>0. && t<d && dot(E-dir*t,E-dir*t)<${(RE * RE).toFixed(1)}) ? 0. : 1.;
  float tw=.7+.3*sin(uTime*(1.7+aSeed*3.)+aSeed*60.);
  float near=clamp(uA/d,0.,1.);
  vB = occ*(1.-aHide)*(lit ? mix(.9*tw,2.2,near) : .2) * clamp(1.8*pow(1200./max(d,1.),.5),.6,2.4);
  vCol = lit ? mix(vec3(.78,.86,1.),vec3(1.,.97,.92),near) : vec3(.55,.45,1.);
  vec4 mv=viewMatrix*vec4(p,1.);
  gl_PointSize = clamp(uA*3./d,2.2,8.)*uPR * step(.01,vB);
  gl_Position=projectionMatrix*mv;
}`;
const FAR_FS = `varying float vB; varying vec3 vCol; void main(){ vec2 c=gl_PointCoord-.5; float r=length(c); if(r>.5) discard;
  float a=smoothstep(.5,0.,r); a=a*a*(.6+.4*a)+smoothstep(.12,0.,r)*.5; gl_FragColor=vec4(vCol*a*vB,1.); }`;

const GLINT_VS = `attribute float aI; attribute float aSz; varying float vI; uniform float uPR; void main(){ vI=aI; vec4 mv=modelViewMatrix*vec4(position,1.); gl_Position=projectionMatrix*mv; gl_PointSize=aSz*uPR; }`;
const GLINT_FS = `varying float vI; void main(){ vec2 c=gl_PointCoord-.5; float r=length(c)*2.; if(vI<.003) discard;
  float core=exp(-r*r*40.)*1.4; float halo=exp(-r*r*6.)*.35;
  float spikes=(exp(-abs(c.y)*120.)+exp(-abs(c.x)*120.))*(1.-r)*.9;
  float spk2=(exp(-abs(c.x+c.y)*90.)+exp(-abs(c.x-c.y)*90.))*(1.-r)*.25;
  float a=(core+halo+spikes+spk2)*vI; gl_FragColor=vec4(vec3(1.,.96,.9)*a,1.); }`;

const EARTH_VS = `varying vec2 vUv; varying vec3 vN; varying vec3 vW; void main(){ vUv=uv; vN=normalize(mat3(modelMatrix)*normal); vec4 w=modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`;
const EARTH_FS = `uniform sampler2D uDay; uniform sampler2D uNight; uniform vec3 uSun; varying vec2 vUv; varying vec3 vN; varying vec3 vW;
void main(){ vec3 n=normalize(vN); vec3 v=normalize(-vW); float l=dot(n,uSun);
  vec3 col=texture2D(uDay,vUv).rgb*max(l,0.)*.06 + texture2D(uNight,vUv).rgb*vec3(1.,.75,.45)*.22*(1.-smoothstep(-.1,.2,l));
  float fr=pow(1.-max(dot(n,v),0.),5.); col+=vec3(.25,.5,1.)*fr*.9*smoothstep(-.4,.5,l);
  gl_FragColor=vec4(col,1.);
  #include <colorspace_fragment>
}`;
const ATM_FS = `uniform vec3 uSun; varying vec3 vN; varying vec3 vW; varying vec2 vUv;
void main(){ vec3 n=normalize(vN); vec3 v=normalize(-vW); float rim=pow(clamp(1.-abs(dot(n,v)),0.,1.),6.); float lit=smoothstep(-.4,.5,dot(n,uSun));
  vec3 c=mix(vec3(.2,.12,.55),vec3(.3,.62,1.),lit); gl_FragColor=vec4(c*rim*(.3+lit)*.9,1.); }`;
const RAIL_VS = `attribute float aT; varying float vT; void main(){ vT=aT; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`;
const RAIL_FS = `uniform vec3 uCol; uniform float uA; varying float vT; void main(){ float a=uA*pow(1.-abs(vT),3.); gl_FragColor=vec4(uCol*a,1.); }`;

function solarTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128; const g = c.getContext('2d');
  g.fillStyle = '#05081a'; g.fillRect(0, 0, 512, 128);
  for (let x = 0; x < 512; x += 6) for (let y = 0; y < 128; y += 6) { const k = Math.random() * 14; g.fillStyle = `rgb(${14 + k},${22 + k},${58 + k * 2})`; g.fillRect(x + 0.6, y + 0.6, 4.8, 4.8); }
  g.fillStyle = 'rgba(170,185,215,.55)'; for (let x = 0; x < 512; x += 64) g.fillRect(x, 0, 1.5, 128); g.fillRect(0, 63, 512, 2);
  g.strokeStyle = 'rgba(200,210,230,.8)'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, 509, 125);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

export function createOrbit({ canvas, max, keep = [], onProgress = () => {}, onFirstFrame = () => {}, onSelect = () => {}, onDetail = () => {} }) {
  const mobile = matchMedia('(max-width: 760px), (pointer: coarse)').matches;
  const K = mobile ? 14 : 44;            // near-field satellites drawn as bodies
  const NEAR_KM = mobile ? 700 : 1100;   // near-field cutoff
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, alpha: false, powerPreference: 'high-performance' });
  const PR = Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2);
  renderer.setPixelRatio(PR); renderer.setClearColor(0x02030a, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(mobile ? 64 : 52, 1, 0.0015, 80000);
  camera.position.set(0, 0, 0);

  const uSun = { value: sunDir(Date.now()) };
  const uTime = { value: 0 };

  // ── sky: procedural Milky Way oriented to the real galactic plane + stars ──
  const skyScene = new THREE.Scene(); const sky = skyScene;
  {
    const m = new THREE.ShaderMaterial({ uniforms: { uGNP: { value: radec(192.8595, 27.1283) }, uGC: { value: radec(266.405, -28.936) } },
      vertexShader: SKY_VS.replace('gl_Position=p.xyww','gl_Position=p'), fragmentShader: SKY_FS.replace(/OCT/g, mobile ? '3' : '5'), side: THREE.BackSide, depthWrite: false, depthTest: false });
    const s = new THREE.Mesh(new THREE.SphereGeometry(10, 96, 48), m); s.renderOrder = -10; s.frustumCulled = false; sky.add(s);
    const gnp = radec(192.8595, 27.1283), N = mobile ? 3500 : 7000, p = new Float32Array(N * 3), c = new Float32Array(N * 3), sz = new Float32Array(N);
    const v = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      for (;;) { const u = Math.random() * 2 - 1, th = Math.random() * 6.2832, q = Math.sqrt(1 - u * u); v.set(q * Math.cos(th), u, q * Math.sin(th));
        const b = v.dot(gnp); if (Math.random() < 0.35 + 0.65 * Math.exp(-b * b * 10)) break; }
      v.multiplyScalar(9); p.set([v.x, v.y, v.z], i * 3);
      const t = Math.random(); c.set(t < .12 ? [1, .82, .66] : t < .4 ? [.68, .78, 1] : [.95, .97, 1], i * 3);
      sz[i] = Math.pow(Math.random(), 7) * 4.2 + 0.7;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('aC', new THREE.BufferAttribute(c, 3)); g.setAttribute('aS', new THREE.BufferAttribute(sz, 1));
    const st = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: { uPR: { value: PR }, uTime }, vertexShader: STAR_VS, fragmentShader: STAR_FS, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, transparent: true }));
    st.renderOrder = -9; st.frustumCulled = false; sky.add(st);
  }

  // bake the procedural sky once into a cube map (cheap per frame), rotate it with GMST
  const skyStars = sky.children[1]; sky.remove(skyStars);
  const cubeRT = new THREE.WebGLCubeRenderTarget(mobile ? 1024 : 2048, { type: THREE.HalfFloatType });
  const cubeCam = new THREE.CubeCamera(0.1, 100, cubeRT); skyScene.add(cubeCam); cubeCam.update(renderer, skyScene);
  scene.background = cubeRT.texture; scene.backgroundIntensity = 1;
  const starGroup = new THREE.Group(); starGroup.add(skyStars); scene.add(starGroup);
  // ── Earth: far below, only a thin limb at the edge of frame ──
  const loader = new THREE.TextureLoader(); let texN = 0;
  const tex = (u) => loader.load(new URL('../img/' + u, import.meta.url).href, () => onProgress('tex', ++texN / 2), undefined, () => onProgress('tex', ++texN / 2));
  const tDay = tex('earth_atmos_2048.jpg'), tNight = tex('earth_lights_2048.png'); tDay.colorSpace = tNight.colorSpace = THREE.SRGBColorSpace;
  const earth = new THREE.Mesh(new THREE.SphereGeometry(RE, 128, 64), new THREE.ShaderMaterial({ uniforms: { uDay: { value: tDay }, uNight: { value: tNight }, uSun }, vertexShader: EARTH_VS, fragmentShader: EARTH_FS }));
  earth.frustumCulled = false; scene.add(earth);
  const atm = new THREE.Mesh(new THREE.SphereGeometry(RE + 90, 128, 64), new THREE.ShaderMaterial({ uniforms: { uSun }, vertexShader: EARTH_VS, fragmentShader: ATM_FS, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  atm.frustumCulled = false; scene.add(atm);

  // ── near-field bodies (real scale geometry in km; enlarged with distance for visibility) ──
  const bodyGeo = new THREE.BoxGeometry(0.0028, 0.00025, 0.0013);
  const wingGeo = new THREE.BoxGeometry(0.0095, 0.00006, 0.0023).translate(0.0062, 0, 0);
  const boomGeo = new THREE.BoxGeometry(0.0016, 0.00008, 0.00008).translate(0.0018, 0, 0);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xc9ced8, metalness: 0.55, roughness: 0.32, emissive: 0x0a0f1c });
  const wingMat = new THREE.MeshStandardMaterial({ map: solarTexture(), color: 0xffffff, metalness: 0.35, roughness: 0.16, emissive: 0x3a54c0, emissiveIntensity: 0.7 }); wingMat.emissiveMap = wingMat.map;
  const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, K), wings = new THREE.InstancedMesh(wingGeo, wingMat, K), booms = new THREE.InstancedMesh(boomGeo, bodyMat, K);
  for (const m of [bodies, wings, booms]) { m.frustumCulled = false; m.count = 0; m.renderOrder = 3; scene.add(m); m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(K * 3).fill(1), 3); }
  const sunLight = new THREE.DirectionalLight(0xfff4e6, 3.4); scene.add(sunLight); scene.add(sunLight.target);
  const earthShine = new THREE.HemisphereLight(0x22305a, 0x4a6ab0, 1.4); scene.add(earthShine);

  // glints
  const glGeo = new THREE.BufferGeometry();
  glGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(K * 3), 3)); glGeo.setAttribute('aI', new THREE.BufferAttribute(new Float32Array(K), 1)); glGeo.setAttribute('aSz', new THREE.BufferAttribute(new Float32Array(K), 1));
  const glints = new THREE.Points(glGeo, new THREE.ShaderMaterial({ uniforms: { uPR: { value: PR } }, vertexShader: GLINT_VS, fragmentShader: GLINT_FS, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
  glints.frustumCulled = false; glints.renderOrder = 5; scene.add(glints);
  // streaks (relative motion blur for close passes)
  const skGeo = new THREE.BufferGeometry();
  skGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(K * 6), 3)); skGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(K * 6), 3));
  const streaks = new THREE.LineSegments(skGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  streaks.frustumCulled = false; streaks.renderOrder = 4; scene.add(streaks);
  // orbit rails (host + a few neighbours)
  const RAILS = mobile ? 6 : 18, RS = 240;
  const rails = [];
  for (let r = 0; r < RAILS; r++) {
    const g = new THREE.BufferGeometry(); const at = new Float32Array(RS + 1); for (let k = 0; k <= RS; k++) at[k] = (k / RS) * 2 - 1;
    g.setAttribute('aT', new THREE.BufferAttribute(at, 1)); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((RS + 1) * 3), 3));
    const l = new THREE.Line(g, new THREE.ShaderMaterial({ uniforms: { uCol: { value: new THREE.Color(r === 0 ? 0x9fd0ff : 0x6f7dff) }, uA: { value: r === 0 ? 0.42 : 0.14 } }, vertexShader: RAIL_VS, fragmentShader: RAIL_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    l.frustumCulled = false; l.visible = false; l.renderOrder = 2; scene.add(l);
    rails.push({ line: l, world: new Float64Array((RS + 1) * 3), idx: -1 });
  }

  // ── far field ──
  let satGeo = null, satMat = null, meta = [], N = 0, posA = null, posB = null, hide = null, tA = 0, tB = 0, queued = null;
  const uCam = { value: new THREE.Vector3() };
  let warp = 1, simT = Date.now(), gen = 0, reqId = 0, inflight = false, ready = false, pending = {};
  const stepFor = (w) => Math.min(Math.max(w * 1000, 1000), 30000);
  const worker = new Worker(new URL('./sgp4-worker.js', import.meta.url));
  function want(t) { inflight = true; const id = ++reqId; pending[id] = { t, gen }; worker.postMessage({ type: 'prop', t, id }); }
  function resetKeys() { gen++; pending = {}; ready = false; tA = 0; tB = 0; queued = null; const s = stepFor(warp); want(simT); want(simT + s); }

  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'ready') {
      meta = m.meta; N = meta.length;
      satGeo = new THREE.BufferGeometry(); posA = new Float32Array(N * 3); posB = new Float32Array(N * 3); hide = new Float32Array(N);
      const seed = new Float32Array(N); for (let i = 0; i < N; i++) seed[i] = Math.random();
      satGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      satGeo.setAttribute('posA', new THREE.BufferAttribute(posA, 3)); satGeo.setAttribute('posB', new THREE.BufferAttribute(posB, 3));
      satGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1)); satGeo.setAttribute('aHide', new THREE.BufferAttribute(hide, 1));
      satMat = new THREE.ShaderMaterial({ uniforms: { uMix: { value: 0 }, uCam, uSun, uPR: { value: PR }, uTime, uA: { value: mobile ? 260 : 340 } },
        vertexShader: FAR_VS, fragmentShader: FAR_FS, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
      const pts = new THREE.Points(satGeo, satMat); pts.frustumCulled = false; pts.renderOrder = 1; scene.add(pts);
      api.info = { total: m.total, rendered: N, sampled: m.sampled, epochNewest: m.epochNewest, epochMedian: m.epochMedian, meta };
      onProgress('sats', 1, api.info);
      resetKeys(); return;
    }
    if (m.type === 'pos') {
      const p = pending[m.id]; delete pending[m.id]; inflight = false;
      if (!p || p.gen !== gen) return;
      if (!ready) {
        if (!tA) { posA.set(m.pos); tA = m.t; } else { posB.set(m.pos); tB = m.t; ready = true; }
        satGeo.attributes.posA.needsUpdate = satGeo.attributes.posB.needsUpdate = true;
        if (ready && host < 0) satReady.then(chooseHost);
      } else queued = m;
    }
  };

  // ── precise near-field propagation (main thread) ──
  const recs = new Map();
  function rec(i) { let r = recs.get(i); if (!r) { r = SAT.twoline2satrec(meta[i].l1, meta[i].l2); recs.set(i, r); } return r; }
  function ecf(i, ms, out) {
    const pv = SAT.propagate(rec(i), new Date(ms)); if (!pv || !pv.position) return null;
    const p = SAT.eciToEcf(pv.position, SAT.gstime(new Date(ms))); return out.set(p.x, p.z, -p.y);
  }
  function farPos(i, out) { const k = i * 3, f = satMat.uniforms.uMix.value; return out.set(posA[k] + (posB[k] - posA[k]) * f, posA[k + 1] + (posB[k + 1] - posA[k + 1]) * f, posA[k + 2] + (posB[k + 2] - posA[k + 2]) * f); }

  let host = -1, tracked = -1, near = [];
  const keepIds = new Set((keep || []).map(Number));
  function chooseHost() {
    if (host >= 0) return;
    // a 53° shell satellite near 550 km with the most real neighbours within 400 km
    const v = new THREE.Vector3(), w = new THREE.Vector3(); const cand = [];
    for (let i = 0; i < N; i++) { const mm = meta[i]; if (mm.inc < 52.5 || mm.inc > 53.6) continue; farPos(i, v); const alt = v.length() - RE; const sd = v.dot(uSun.value); const lit = sd > 0 || w.copy(v).addScaledVector(uSun.value, -sd).length() > RE + 900; if (alt > 530 && alt < 575 && lit) cand.push(i); }
    const pool = cand.length ? cand : [...Array(N).keys()];
    let best = pool[0], bs = -1;
    for (let k = 0; k < Math.min(pool.length, mobile ? 120 : 260); k++) {
      const i = pool[(Math.random() * pool.length) | 0]; farPos(i, v); let s = 0;
      for (let j = 0; j < N; j++) { if (j === i) continue; const k3 = j * 3; const dx = posA[k3] - v.x, dy = posA[k3 + 1] - v.y, dz = posA[k3 + 2] - v.z, d2 = dx * dx + dy * dy + dz * dz; if (d2 < 160000) s += 1 + 40000 / (d2 + 2500); }
      if (s > bs) { bs = s; best = i; }
    }
    host = best; tracked = host; onSelect({ ...meta[host], index: host, why: 'host' });
    for (const id of keepIds) { const i = meta.findIndex((m) => m.norad === id); if (i >= 0) { tracked = i; onSelect({ ...meta[i], index: i, why: 'decider' }); } }
  }

  // ── camera rig ──
  const camW = new THREE.Vector3(), hostP = new THREE.Vector3(), hostF = new THREE.Vector3(), T = new THREE.Vector3(), R = new THREE.Vector3(), B = new THREE.Vector3();
  const look = new THREE.Vector3(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  let yaw = 0, pitch = 0, tYaw = 0, tPitch = 0, scrollK = 0, scrollS = 0;
  addEventListener('pointermove', (e) => { if (e.pointerType === 'touch') return; tYaw = -(e.clientX / innerWidth - 0.5) * 0.34; tPitch = -(e.clientY / innerHeight - 0.5) * 0.2; }, { passive: true });
  if (mobile && window.DeviceOrientationEvent) addEventListener('deviceorientation', (e) => { if (e.gamma == null) return; tYaw = -Math.max(-1, Math.min(1, e.gamma / 35)) * 0.18; tPitch = -Math.max(-1, Math.min(1, (e.beta - 50) / 35)) * 0.1; }, { passive: true });

  function updateRig(t) {
    if (!ecf(host, simT, hostP) || !ecf(host, simT + 1000, hostF)) return false;
    R.copy(hostP).normalize(); T.subVectors(hostF, hostP).addScaledVector(R, -hostF.clone().sub(hostP).dot(R)).normalize(); B.crossVectors(T, R).normalize();
    scrollS += (scrollK - scrollS) * 0.06; const e = scrollS * scrollS * (3 - 2 * scrollS);
    const a = t * 0.045;
    // ride ~30 m behind / beside the host, slow cinematic drift; scroll pulls back to reveal the shell
    const back = 0.022 + 0.007 * Math.sin(a) + e * 900, up = (mobile ? -0.012 : 0.0012) + 0.0025 * Math.sin(a * 1.3) + e * 260, side = (mobile ? -0.0015 : (0.0012 + 0.002 * Math.cos(a * 0.7))) - e * 60;
    camW.copy(hostP).addScaledVector(T, -back).addScaledVector(R, up).addScaledVector(B, side);
    // look forward along the orbit, tilted up a touch so Earth's limb sits at the bottom edge
    yaw += (tYaw - yaw) * 0.04; pitch += (tPitch - pitch) * 0.04;
    const p0 = (mobile ? 0.2 : 0.075) + pitch + 0.02 * Math.sin(a * 0.8);
    look.copy(T).applyAxisAngle(B, p0).applyAxisAngle(R, yaw + 0.06 * Math.sin(a * 0.5) + 0);
    tmp.copy(T).applyAxisAngle(B, 0.13).applyAxisAngle(R, yaw + 0.25);
    look.lerp(tmp, e).normalize();
    rails.forEach((rr, k) => { rr.line.material.uniforms.uA.value = (k === 0 ? 0.42 : 0.14) * (1 + 4 * e); });
    camera.up.copy(R); camera.lookAt(look);
    uCam.value.copy(camW);
    earth.position.copy(camW).negate(); atm.position.copy(earth.position);
    const gm = -gmstOf(simT); scene.backgroundRotation.set(0, gm, 0); starGroup.rotation.y = gm;
    return true;
  }

  // near set refresh
  let lastNear = 0;
  function refreshNear() {
    const v = new THREE.Vector3(), list = [];
    const c2 = NEAR_KM * NEAR_KM;
    for (let i = 0; i < N; i++) { farPos(i, v); const d2 = v.distanceToSquared(camW); if (d2 < c2) list.push([d2, i]); }
    list.sort((x, y) => x[0] - y[0]);
    const nn = list.slice(0, K).map((x) => x[1]);
    if (host >= 0 && !nn.includes(host)) { nn.pop(); nn.unshift(host); }
    if (tracked >= 0 && !nn.includes(tracked)) { nn.pop(); nn.push(tracked); }
    for (const i of near) hide[i] = 0; for (const i of nn) hide[i] = 1; satGeo.attributes.aHide.needsUpdate = true;
    near = nn;
  }
  // rails
  let lastRails = 0;
  function refreshRails() {
    const g = SAT.gstime(new Date(simT));
    const pick = [host, ...near.filter((i) => i !== host).slice(0, RAILS - 1)];
    pick.forEach((i, r) => {
      const rr = rails[r]; if (!rr) return; rr.idx = i;
      const rc = rec(i), period = (2 * Math.PI / rc.no) * 60000; // ms
      for (let k = 0; k <= RS; k++) {
        const pv = SAT.propagate(rc, new Date(simT + period * 0.5 * ((k / RS) * 2 - 1)));
        if (!pv || !pv.position) continue; const p = SAT.eciToEcf(pv.position, g);
        rr.world[k * 3] = p.x; rr.world[k * 3 + 1] = p.z; rr.world[k * 3 + 2] = -p.y;
      }
      rr.line.visible = true;
    });
  }

  // per-frame near field
  const P = new THREE.Vector3(), PF = new THREE.Vector3(), X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), M = new THREE.Matrix4(), Mw = new THREE.Matrix4(), Q = new THREE.Vector3(), S3 = new THREE.Vector3();
  const relPos = new Map(); const camF = new THREE.Vector3();
  function updateNear(t) {
    const gp = glGeo.attributes.position.array, gi = glGeo.attributes.aI.array, gs = glGeo.attributes.aSz.array;
    const sp = skGeo.attributes.position.array, sc = skGeo.attributes.color.array;
    const sun = uSun.value; relPos.clear();
    // camera velocity (km/s)
    camF.copy(hostF).sub(hostP);
    let n = 0;
    for (let q = 0; q < near.length; q++) {
      const i = near[q];
      if (!ecf(i, simT, P) || !ecf(i, simT + 1000, PF)) continue;
      const rel = P.clone().sub(camW), d = rel.length(); relPos.set(i, rel);
      const Ri = P.clone().normalize(), Ti = PF.clone().sub(P).normalize(), Bi = Ti.clone().cross(Ri).normalize();
      // enlargement: true scale up close, then a gentle angular floor so neighbours read as satellites
      const enl = 1 + Math.max(0, (0.11 * Math.sqrt(d)) / 0.0106 - 1) * THREE.MathUtils.smoothstep(d, 0.3, 3);
      const sd = P.dot(sun), lit = sd > 0 || P.clone().addScaledVector(sun, -sd).length() > RE;
      // body: x = cross-track (wing axis), y = zenith, z = along-track
      M.makeBasis(Bi, Ri, Ti); M.scale(S3.set(enl, enl, enl)); M.setPosition(rel);
      bodies.setMatrixAt(n, M); booms.setMatrixAt(n, M);
      // wing: rotate about its long axis to face the sun (with a slow wobble → glints come and go)
      Y.copy(sun).addScaledVector(Bi, -sun.dot(Bi)).normalize();
      const wob = 0.22 * Math.sin(t * 0.35 + i * 1.7); Y.applyAxisAngle(Bi, wob);
      Z.crossVectors(Bi, Y).normalize();
      Mw.makeBasis(Bi, Y, Z); Mw.scale(S3); Mw.setPosition(rel); wings.setMatrixAt(n, Mw);
      const shade = lit ? 1 : 0.45; for (const m of [bodies, wings, booms]) m.instanceColor.setXYZ(n, shade, shade, shade);
      // glint: mirror reflection of the sun off the wing towards the camera
      const toCam = rel.clone().negate().normalize();
      const refl = sun.clone().negate().reflect(Y);
      const spec = lit ? Math.pow(Math.max(refl.dot(toCam), 0), 24) : 0;
      const wingC = Q.copy(Bi).multiplyScalar(0.0062 * enl).add(rel);
      gp[n * 3] = wingC.x; gp[n * 3 + 1] = wingC.y; gp[n * 3 + 2] = wingC.z;
      gi[n] = lit ? Math.min(1.8, (0.7 + spec * 2.4) * (d < 0.3 ? 0.25 : 1)) : 0.06;
      gs[n] = (22 + 140 * spec) * (1 / (1 + d / 400)) + 10;
      // streak: relative motion over a short exposure
      const vrel = PF.clone().sub(P).sub(camF); const exp = Math.min(0.5 * Math.max(warp, 1), 40);
      const tail = rel.clone().addScaledVector(vrel, -exp);
      sp.set([rel.x, rel.y, rel.z, tail.x, tail.y, tail.z], n * 6);
      const sb = lit && d > 0.5 ? Math.min(0.55, 60 / d) : 0; sc.set([sb * .8, sb * .9, sb, 0, 0, 0], n * 6);
      n++;
    }
    for (const m of [bodies, wings, booms]) { m.count = n; m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; }
    glGeo.setDrawRange(0, n); glGeo.attributes.position.needsUpdate = glGeo.attributes.aI.needsUpdate = glGeo.attributes.aSz.needsUpdate = true;
    skGeo.setDrawRange(0, n * 2); skGeo.attributes.position.needsUpdate = skGeo.attributes.color.needsUpdate = true;
    // rails relative to camera
    for (const rr of rails) { if (!rr.line.visible) continue; const a = rr.line.geometry.attributes.position.array;
      for (let k = 0; k < a.length; k += 3) { a[k] = rr.world[k] - camW.x; a[k + 1] = rr.world[k + 1] - camW.y; a[k + 2] = rr.world[k + 2] - camW.z; }
      rr.line.geometry.attributes.position.needsUpdate = true; }
    sunLight.position.copy(sun).multiplyScalar(10); sunLight.target.position.set(0, 0, 0);
    earthShine.position.copy(R);
  }

  // tour: track real neighbours that are on screen
  let tourAt = performance.now() + 9000, userHold = 0;
  function tour(now) {
    if (now < tourAt || now < userHold) return; tourAt = now + 8500;
    const cand = near.filter((i) => { const r = relPos.get(i); if (!r) return false; const s = r.clone().applyMatrix4(camera.matrixWorldInverse); if (s.z > -0.05) return false; const p = r.clone().project(camera); return Math.abs(p.x) < 0.75 && Math.abs(p.y) < 0.7; });
    if (!cand.length) return;
    const pickI = cand[(Math.random() * Math.min(cand.length, 8)) | 0];
    if (keepIds.size && meta[tracked] && keepIds.has(meta[tracked].norad)) return;
    tracked = pickI; lastDetail = 0; onSelect({ ...meta[tracked], index: tracked, why: tracked === host ? 'host' : 'near' });
  }

  // picking
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || host < 0) return; const mv = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null; if (mv > 6) return;
    let best = -1, bd = (mobile ? 26 : 16) ** 2; const v = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const r = relPos.get(i) || farPos(i, v).sub(camW); const c = r.clone().applyMatrix4(camera.matrixWorldInverse); if (c.z > 0) continue;
      const d = r.length(), E = camW.clone().negate(), dir = r.clone().divideScalar(d), tt = E.dot(dir); if (tt > 0 && tt < d && E.sub(dir.multiplyScalar(tt)).lengthSq() < RE * RE) continue;
      const p = r.clone().project(camera), sx = (p.x * .5 + .5) * innerWidth, sy = (-p.y * .5 + .5) * innerHeight, dd = (sx - e.clientX) ** 2 + (sy - e.clientY) ** 2;
      if (dd < bd) { bd = dd; best = i; }
    }
    if (best >= 0) { tracked = best; userHold = performance.now() + 30000; if (!near.includes(best)) { near.pop(); near.push(best); hide[best] = 1; satGeo.attributes.aHide.needsUpdate = true; } onSelect({ ...meta[best], index: best, why: 'user' }); }
  });

  function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  addEventListener('resize', resize); resize();

  const clock = new THREE.Clock(); let visible = true, first = false, lastDetail = 0;
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; if (visible) { clock.getDelta(); loop(); } });
  function loop() {
    if (!visible) return; requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime, now = performance.now();
    simT += dt * 1000 * warp; uTime.value = t; uSun.value.copy(sunDir(simT));
    if (ready) {
      if (simT >= tB && queued) { posA.set(posB); tA = tB; posB.set(queued.pos); tB = queued.t; queued = null; satGeo.attributes.posA.needsUpdate = satGeo.attributes.posB.needsUpdate = true; }
      if (!queued && !inflight && simT > tA) want(tB + stepFor(warp));
      satMat.uniforms.uMix.value = Math.min(Math.max((simT - tA) / (tB - tA), 0), 1);
    }
    if (ready && SAT && host >= 0 && updateRig(t)) {
      camera.updateMatrixWorld();
      if (now - lastNear > (warp > 1 ? 150 : 400)) { lastNear = now; refreshNear(); }
      if (now - lastRails > (warp > 1 ? 1000 : 2500)) { lastRails = now; refreshRails(); }
      updateNear(t); tour(now);
      // reticle + detail for the tracked satellite
      const r = relPos.get(tracked);
      if (r && api.onLabel) {
        const c = r.clone().applyMatrix4(camera.matrixWorldInverse), p = r.clone().project(camera);
        api.onLabel((p.x * .5 + .5) * innerWidth, (-p.y * .5 + .5) * innerHeight, c.z > 0 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05, r.length());
      }
      if (now - lastDetail > 500 && tracked >= 0) {
        lastDetail = now; const d = new Date(simT), pv = SAT.propagate(rec(tracked), d);
        if (pv && pv.position) { const geo = SAT.eciToGeodetic(pv.position, SAT.gstime(d)), v = pv.velocity, Pw = new THREE.Vector3(); ecf(tracked, simT, Pw); const sd = Pw.dot(uSun.value);
          onDetail({ ...meta[tracked], lat: SAT.degreesLat(geo.latitude), lon: SAT.degreesLong(geo.longitude), alt: geo.height, vel: Math.hypot(v.x, v.y, v.z), range: Pw.distanceTo(camW), camAlt: camW.length() - RE, host: meta[host].name, lit: sd > 0 || Pw.clone().addScaledVector(uSun.value, -sd).length() > RE }); }
      }
      if (!first) { first = true; requestAnimationFrame(() => requestAnimationFrame(onFirstFrame)); }
    }
    renderer.render(scene, camera);
  }
  loop();

  const api = {
    info: null,
    load(text) { worker.postMessage({ type: 'init', text, max, keep, t: simT }); },
    setWarp(w) { warp = w; resetKeys(); },
    selectNorad(id) { const i = meta.findIndex((m) => m.norad === +id); if (i >= 0) { tracked = i; onSelect({ ...meta[i], index: i, why: 'decider' }); } return i; },
    select(i) { tracked = i; onSelect({ ...meta[i], index: i, why: 'user' }); },
    get simT() { return simT; }, get N() { return N; },
    setScroll(k) { scrollK = k; },
    onLabel: null,
  };
  return api;
}
