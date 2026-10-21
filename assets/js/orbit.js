// STAR · IN-SHELL renderer v3. The camera rides inside the Starlink shell (~550 km) next to a real satellite.
// Far field: every satellite, SGP4 keyframes from a worker, GPU-interpolated (camera-relative, km).
// Near field: nearest real satellites propagated on the main thread each frame. The ridden satellite is a
// high-detail procedural model; neighbours use an instanced LOD. Earth + atmosphere are analytic (ray-traced
// per pixel → no facets). Post: bloom, MSAA/FXAA, grain, chromatic aberration, lens flare. Units: km, Earth-fixed.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeSatKit, buildSatellite, lodGeometries } from './starsat.js';

const DEG = Math.PI / 180, RE = 6371.0;
let SAT = null;
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

// analytic Earth + atmosphere, full-screen, per-pixel ray/sphere → perfectly smooth limb
const EARTH_VS = `varying vec3 vRay; uniform mat4 uInvProj; uniform mat4 uCamWorld;
void main(){ vec4 v=uInvProj*vec4(position.xy,1.,1.); vRay=(uCamWorld*vec4(v.xyz/v.w,0.)).xyz; gl_Position=vec4(position.xy,0.,1.); }`;
const EARTH_FS = `uniform vec3 uC; uniform vec3 uSun; uniform sampler2D uDay; uniform sampler2D uNight; varying vec3 vRay;
const float R=${RE.toFixed(1)}; const float RA=${(RE + 140).toFixed(1)}; const float HR=8.0; const float HM=1.4;
const vec3 BR=vec3(5.8e-3,13.5e-3,33.1e-3); const vec3 BM=vec3(8e-3);
float hash(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
vec3 sunTint(float mu){ float k=1.-smoothstep(-.05,.35,mu); return exp(-BR*HR*60.*k*k); }
vec4 groundTex(vec3 n){
  float lon=atan(-n.z,n.x), lat=asin(clamp(n.y,-1.,1.));
  vec2 uv=vec2(lon/6.2831853+.5, lat/3.1415927+.5), uv2=vec2(fract(uv.x+.5),uv.y);
  vec2 dx=dFdx(uv), dy=dFdy(uv), dx2=dFdx(uv2), dy2=dFdy(uv2);
  if(abs(dx2.x)+abs(dy2.x) < abs(dx.x)+abs(dy.x)) { dx=dx2; dy=dy2; }
  return vec4(textureGrad(uDay,uv,dx,dy).rgb, textureGrad(uNight,uv,dx,dy).r);
}
void main(){
  vec3 rd=normalize(vRay); vec3 oc=-uC;
  float b=dot(oc,rd); float c=dot(oc,oc)-RA*RA; float disc=b*b-c; if(disc<0.) discard;
  float tFar=-b+sqrt(disc); if(tFar<0.) discard;
  float cp=dot(oc,oc)-R*R, dp=b*b-cp; float tHit=-1.; if(dp>0.){ float tt=-b-sqrt(dp); if(tt>0.) tHit=tt; }
  vec3 col=vec3(0.); float a=0.;
  vec3 tp=oc+rd*max(-b,0.); float hmin=length(tp)-R;            // closest approach (limb) altitude
  if(tHit<0.){
    // limb: Chapman column through the shell at the tangent altitude
    float colR=exp(-max(hmin,0.)/HR)*sqrt(6.2831853*R*HR), colM=exp(-max(hmin,0.)/HM)*sqrt(6.2831853*R*HM);
    vec3 n=normalize(tp); float mu=dot(n,uSun); float lit=smoothstep(-.16,.06,mu);
    float cosT=dot(rd,uSun); float pR=.75*(1.+cosT*cosT); float g=.76; float pM=(1.-g*g)/pow(1.+g*g-2.*g*cosT,1.5)*.08;
    vec3 sc=(1.-exp(-BR*colR))*pR + (1.-exp(-BM*colM))*pM;
    col=sc*lit*sunTint(mu)*1.6;
    // airglow (≈95 km emission layer), visible on the night side
    float ag=exp(-pow((hmin-95.)/3.2,2.));
    col+=vec3(.22,.95,.45)*ag*.10*(1.-lit*.8);
    col+=vec3(.25,.45,1.)*exp(-max(hmin,0.)/30.)*.008*lit;          // faint haze
    a=clamp(1.-exp(-dot(BR,vec3(colR))*.3),0.,1.)*.6;
  } else {
    vec3 p=oc+rd*tHit; vec3 n=normalize(p); float mu=dot(n,uSun);
    float cosV=max(dot(-rd,n),.002); float colR=HR*min(1./cosV,sqrt(6.2831853*R/HR)), colM=HM*min(1./cosV,sqrt(6.2831853*R/HM));
    vec3 T=exp(-(BR*colR+BM*colM));
    vec4 gt=groundTex(n);
    vec3 ground=gt.rgb*max(mu,0.)*.07 + vec3(1.,.72,.42)*gt.a*.16*(1.-smoothstep(-.12,.12,mu));
    float lit=smoothstep(-.12,.08,mu);
    vec3 sc=(1.-T)*vec3(.55,.75,1.)*lit*sunTint(mu)*.9;
    col=ground*T+sc; a=1.;
  }
  col+=(hash(gl_FragCoord.xy)-.5)/255.;                         // dither → no banding
  gl_FragColor=vec4(col,a);
}`;
const RAIL_VS = `attribute float aT; uniform vec3 uC; varying float vT; varying float vO;
void main(){ vT=aT; vec3 p=position; float d=length(p); vec3 dir=p/max(d,1e-3); float t=dot(uC,dir);
  vO=(t>0. && t<d && dot(uC-dir*t,uC-dir*t)<${(RE * RE).toFixed(1)})?0.:1.;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.); }`;
const RAIL_FS = `uniform vec3 uCol; uniform float uA; varying float vT; varying float vO; void main(){ float a=uA*pow(1.-abs(vT),3.)*vO; gl_FragColor=vec4(uCol*a,1.); }`;
// final: chromatic aberration + grain + vignette + lens flare + dither (runs after tone mapping, in sRGB)
const FINAL = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uCA: { value: 0.006 }, uGrain: { value: 0.035 },
    uSunUV: { value: new THREE.Vector2(-9, -9) }, uSunVis: { value: 0 }, uFlareI: { value: 0 }, uFlareUV: { value: new THREE.Vector2(-9, -9) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime, uCA, uGrain, uSunVis, uFlareI; uniform vec2 uRes, uSunUV, uFlareUV; varying vec2 vUv;
  float h(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
  vec3 ghosts(vec2 uv, vec2 s, float I){
    vec2 asp=vec2(uRes.x/uRes.y,1.); vec3 c=vec3(0.); vec2 ax=vec2(.5)-s;
    for(int k=1;k<6;k++){ float fk=float(k); vec2 gp=s+ax*(fk*.42); float r=length((uv-gp)*asp); float sz=.012+.018*fract(fk*.37);
      c+=mix(vec3(.4,.6,1.),vec3(.8,.5,1.),fract(fk*.61))*smoothstep(sz,sz*.2,r)*.14; }
    vec2 d=(uv-s)*asp; float r=length(d); float a=atan(d.y,d.x);
    c+=vec3(1.,.95,.88)*(exp(-r*r*1400.)*.5 + exp(-r*26.)*.018 + pow(abs(cos(a*3.)),80.)*exp(-r*9.)*.08);
    c+=vec3(.6,.75,1.)*exp(-abs(d.y)*400.)*exp(-abs(d.x)*4.)*.05; // anamorphic streak
    return c*I; }
  void main(){ vec2 d=vUv-.5; float r2=dot(d,d); vec2 o=d*r2*uCA;
    vec3 c=vec3(texture2D(tDiffuse,vUv-o).r, texture2D(tDiffuse,vUv).g, texture2D(tDiffuse,vUv+o).b);
    if(uSunVis>0.) c+=ghosts(vUv,uSunUV,uSunVis);
    if(uFlareI>0.) c+=ghosts(vUv,uFlareUV,uFlareI)*.45;
    c*=1.-r2*.38;
    c+=(h(vUv*uRes+fract(uTime)*97.)-.5)*uGrain;
    c+=(h(vUv*uRes.yx+3.1)-.5)/255.;
    gl_FragColor=vec4(c,1.); }`,
};
const ENV_FS = `uniform vec3 uSun; uniform vec3 uUp; varying vec3 vD;
void main(){ vec3 d=normalize(vD); float u=dot(d,uUp);
  vec3 c=mix(vec3(.0,.0,.004),vec3(.05,.10,.22),smoothstep(.15,-.5,u)) + vec3(.10,.16,.30)*exp(-pow((u+.33)*9.,2.))*.8;
  float s=max(dot(d,uSun),0.); c+=vec3(1.,.96,.9)*(pow(s,2400.)*240.+pow(s,60.)*.25);
  gl_FragColor=vec4(c,1.); }`;

export function createOrbit({ canvas, max, keep = [], onProgress = () => {}, onFirstFrame = () => {}, onSelect = () => {}, onDetail = () => {} }) {
  const mobile = matchMedia('(max-width: 760px), (pointer: coarse)').matches;
  const forced = new URLSearchParams(location.search).get('tier');
  let tier = ['high', 'medium', 'low'].includes(forced) ? forced : mobile ? 'low' : 'high';
  const K = mobile ? 14 : 44, NEAR_KM = mobile ? 700 : 1100;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false });
  const prFor = (t) => Math.min(devicePixelRatio || 1, t === 'high' ? 2 : t === 'medium' ? 1.5 : 1.35);
  let PR = prFor(tier);
  renderer.setPixelRatio(PR); renderer.setClearColor(0x02030a, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.78;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(mobile ? 64 : 50, 1, 0.0012, 80000);
  const uSun = { value: sunDir(Date.now()) }, uTime = { value: 0 };

  // ── sky (procedural Milky Way baked once into a cube map) + stars ──
  const skyScene = new THREE.Scene();
  {
    const m = new THREE.ShaderMaterial({ uniforms: { uGNP: { value: radec(192.8595, 27.1283) }, uGC: { value: radec(266.405, -28.936) } },
      vertexShader: SKY_VS.replace('gl_Position=p.xyww', 'gl_Position=p'), fragmentShader: SKY_FS.replace(/OCT/g, mobile ? '3' : '5'), side: THREE.BackSide, depthWrite: false, depthTest: false });
    skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 96, 48), m));
  }
  const cubeRT = new THREE.WebGLCubeRenderTarget(mobile ? 1024 : 2048, { type: THREE.HalfFloatType });
  new THREE.CubeCamera(0.1, 100, cubeRT).update(renderer, skyScene);
  scene.background = cubeRT.texture;
  const starGroup = new THREE.Group(); scene.add(starGroup);
  {
    const gnp = radec(192.8595, 27.1283), N = mobile ? 3500 : 7000, p = new Float32Array(N * 3), c = new Float32Array(N * 3), sz = new Float32Array(N), v = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      for (;;) { const u = Math.random() * 2 - 1, th = Math.random() * 6.2832, q = Math.sqrt(1 - u * u); v.set(q * Math.cos(th), u, q * Math.sin(th)); const b = v.dot(gnp); if (Math.random() < 0.35 + 0.65 * Math.exp(-b * b * 10)) break; }
      v.multiplyScalar(9); p.set([v.x, v.y, v.z], i * 3);
      const t = Math.random(); c.set(t < .12 ? [1, .82, .66] : t < .4 ? [.68, .78, 1] : [.95, .97, 1], i * 3);
      sz[i] = Math.pow(Math.random(), 7) * 4.2 + 0.7;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('aC', new THREE.BufferAttribute(c, 3)); g.setAttribute('aS', new THREE.BufferAttribute(sz, 1));
    const st = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: { uPR: { value: PR }, uTime }, vertexShader: STAR_VS, fragmentShader: STAR_FS, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, transparent: true }));
    st.renderOrder = -9; st.frustumCulled = false; starGroup.add(st);
  }

  // ── analytic Earth + atmosphere (full-screen) ──
  const loader = new THREE.TextureLoader(); let texN = 0;
  const tex = (u) => loader.load(new URL('../img/' + u, import.meta.url).href, () => onProgress('tex', ++texN / 2), undefined, () => onProgress('tex', ++texN / 2));
  const tDay = tex('earth_atmos_2048.jpg'), tNight = tex('earth_lights_2048.png'); tDay.colorSpace = tNight.colorSpace = THREE.SRGBColorSpace;
  const uC = { value: new THREE.Vector3() };
  const earthMat = new THREE.ShaderMaterial({ uniforms: { uC, uSun, uDay: { value: tDay }, uNight: { value: tNight }, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() } },
    vertexShader: EARTH_VS, fragmentShader: EARTH_FS, depthWrite: false, depthTest: false, transparent: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor });
  const earthQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), earthMat); earthQuad.frustumCulled = false; earthQuad.renderOrder = -5; scene.add(earthQuad);

  // ── materials, environment, lights ──
  const kit = makeSatKit(tier === 'low' ? 'low' : 'high');
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envMat = new THREE.ShaderMaterial({ uniforms: { uSun: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3(0, 1, 0) } }, vertexShader: `varying vec3 vD; void main(){ vD=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`, fragmentShader: ENV_FS, side: THREE.BackSide });
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), envMat));
  let envRT = null, envSun = new THREE.Vector3(), envUp = new THREE.Vector3();
  function updateEnv(up) {
    if (envRT && envSun.angleTo(uSun.value) < 0.03 && envUp.angleTo(up) < 0.03) return;
    envSun.copy(uSun.value); envUp.copy(up); envMat.uniforms.uSun.value.copy(uSun.value); envMat.uniforms.uUp.value.copy(up);
    const old = envRT; envRT = pmrem.fromScene(envScene, 0.02); scene.environment = envRT.texture; if (old) old.dispose();
  }
  const sunLight = new THREE.DirectionalLight(0xfff2e2, 2.6); scene.add(sunLight, sunLight.target);
  const earthShine = new THREE.HemisphereLight(0x0c1226, 0x3a5aa0, 0.5); scene.add(earthShine);

  // ── ridden satellite: high-detail model (metres → km) ──
  const hero = buildSatellite(kit); const heroG = hero.group; heroG.scale.setScalar(0.001); heroG.visible = false; scene.add(heroG);
  heroG.traverse((o) => { if (o.isMesh) o.renderOrder = 3; });
  // ── neighbours: instanced LOD ──
  const lod = lodGeometries();
  const lodWing = mergeGeometries([lod.wingL, lod.wingR]); lod.body.scale(0.001, 0.001, 0.001); lodWing.scale(0.001, 0.001, 0.001);
  const nbBodyMat = new THREE.MeshPhysicalMaterial({ color: 0xc0c5ce, metalness: 1, roughness: 0.3 });
  const nbWingMat = new THREE.MeshPhysicalMaterial({ color: 0x1a2a66, metalness: 0.25, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05, emissive: 0x0b1440, emissiveIntensity: 0.5 });
  const nbBodies = new THREE.InstancedMesh(lod.body, nbBodyMat, K), nbWings = new THREE.InstancedMesh(lodWing, nbWingMat, K);
  for (const m of [nbBodies, nbWings]) { m.frustumCulled = false; m.count = 0; m.renderOrder = 3; m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(K * 3).fill(1), 3); scene.add(m); }

  // glints (neighbours + 2 hero wing slots)
  const GN = K + 2, glGeo = new THREE.BufferGeometry();
  glGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(GN * 3), 3)); glGeo.setAttribute('aI', new THREE.BufferAttribute(new Float32Array(GN), 1)); glGeo.setAttribute('aSz', new THREE.BufferAttribute(new Float32Array(GN), 1));
  const glints = new THREE.Points(glGeo, new THREE.ShaderMaterial({ uniforms: { uPR: { value: PR } }, vertexShader: GLINT_VS, fragmentShader: GLINT_FS, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending }));
  glints.frustumCulled = false; glints.renderOrder = 5; scene.add(glints);
  const skGeo = new THREE.BufferGeometry();
  skGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(K * 6), 3)); skGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(K * 6), 3));
  const streaks = new THREE.LineSegments(skGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  streaks.frustumCulled = false; streaks.renderOrder = 4; scene.add(streaks);
  const RAILS = mobile ? 6 : 18, RS = 240, rails = [];
  for (let r = 0; r < RAILS; r++) {
    const g = new THREE.BufferGeometry(); const at = new Float32Array(RS + 1); for (let k = 0; k <= RS; k++) at[k] = (k / RS) * 2 - 1;
    g.setAttribute('aT', new THREE.BufferAttribute(at, 1)); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((RS + 1) * 3), 3));
    const l = new THREE.Line(g, new THREE.ShaderMaterial({ uniforms: { uC, uCol: { value: new THREE.Color(r === 0 ? 0x9fd0ff : 0x6f7dff) }, uA: { value: 0.3 } }, vertexShader: RAIL_VS, fragmentShader: RAIL_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    l.frustumCulled = false; l.visible = false; l.renderOrder = 2; scene.add(l); rails.push({ line: l, world: new Float64Array((RS + 1) * 3), idx: -1 });
  }

  // ── post-processing ──
  let composer = null, bloom = null, fxaa = null, final = null;
  function buildComposer() {
    if (composer) { composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); }
    PR = prFor(tier); renderer.setPixelRatio(PR);
    const w = innerWidth, h = innerHeight;
    const rt = new THREE.WebGLRenderTarget(w * PR, h * PR, { type: THREE.HalfFloatType, samples: tier === 'high' ? 4 : 0 });
    composer = new EffectComposer(renderer, rt); composer.setPixelRatio(PR); composer.setSize(w, h);
    composer.addPass(new RenderPass(scene, camera));
    bloom = null; fxaa = null; final = null;
    if (tier !== 'low') { bloom = new UnrealBloomPass(new THREE.Vector2(w * (tier === 'high' ? 1 : 0.5), h * (tier === 'high' ? 1 : 0.5)), 0.22, 0.2, 2.2); composer.addPass(bloom); }
    composer.addPass(new OutputPass());
    if (tier === 'medium') { fxaa = new ShaderPass(FXAAShader); fxaa.material.uniforms.resolution.value.set(1 / (w * PR), 1 / (h * PR)); composer.addPass(fxaa); }
    if (tier !== 'low') { final = new ShaderPass(FINAL); final.uniforms.uRes.value.set(w * PR, h * PR); if (tier === 'medium') final.uniforms.uGrain.value = 0.02; composer.addPass(final); }
  }

  // ── far field (worker) ──
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
      onProgress('sats', 1, api.info); resetKeys(); return;
    }
    if (m.type === 'pos') {
      const p = pending[m.id]; delete pending[m.id]; inflight = false;
      if (!p || p.gen !== gen) return;
      if (!ready) { if (!tA) { posA.set(m.pos); tA = m.t; } else { posB.set(m.pos); tB = m.t; ready = true; }
        satGeo.attributes.posA.needsUpdate = satGeo.attributes.posB.needsUpdate = true;
        if (ready && host < 0) satReady.then(chooseHost);
      } else queued = m;
    }
  };

  const recs = new Map();
  function rec(i) { let r = recs.get(i); if (!r) { r = SAT.twoline2satrec(meta[i].l1, meta[i].l2); recs.set(i, r); } return r; }
  function ecf(i, ms, out) { const d = new Date(ms), pv = SAT.propagate(rec(i), d); if (!pv || !pv.position) return null; const p = SAT.eciToEcf(pv.position, SAT.gstime(d)); return out.set(p.x, p.z, -p.y); }
  function farPos(i, out) { const k = i * 3, f = satMat.uniforms.uMix.value; return out.set(posA[k] + (posB[k] - posA[k]) * f, posA[k + 1] + (posB[k + 1] - posA[k + 1]) * f, posA[k + 2] + (posB[k + 2] - posA[k + 2]) * f); }
  const isLit = (P, sun) => { const sd = P.dot(sun); if (sd > 0) return true; const px = P.x - sd * sun.x, py = P.y - sd * sun.y, pz = P.z - sd * sun.z; return px * px + py * py + pz * pz > RE * RE; };

  let host = -1, tracked = -1, near = [], camSide = -1;
  const keepIds = new Set((keep || []).map(Number));
  function chooseHost() {
    if (host >= 0) return;
    const v = new THREE.Vector3(), cand = [];
    for (let i = 0; i < N; i++) { const mm = meta[i]; if (mm.inc < 52.5 || mm.inc > 53.6) continue; farPos(i, v); const alt = v.length() - RE; const sd = v.dot(uSun.value);
      const deep = sd > 0 || v.clone().addScaledVector(uSun.value, -sd).length() > RE + 900; if (alt > 530 && alt < 575 && deep) cand.push(i); }
    const pool = cand.length ? cand : [...Array(N).keys()];
    let best = pool[0], bs = -1;
    for (let k = 0; k < Math.min(pool.length, mobile ? 160 : 400); k++) {
      const i = pool[(Math.random() * pool.length) | 0]; farPos(i, v); let s = 0;
      for (let j = 0; j < N; j++) { if (j === i) continue; const k3 = j * 3; const dx = posA[k3] - v.x, dy = posA[k3 + 1] - v.y, dz = posA[k3 + 2] - v.z, d2 = dx * dx + dy * dy + dz * dz; if (d2 < 160000) s += 1 + 40000 / (d2 + 2500); }
      // prefer dawn/dusk geometry (Sun along-track) so the sun-tracking wings face the camera, horizon stays level
      const k3 = i * 3; const tv = new THREE.Vector3(posB[k3] - posA[k3], posB[k3 + 1] - posA[k3 + 1], posB[k3 + 2] - posA[k3 + 2]).normalize();
      const st = Math.abs(tv.dot(uSun.value)); s *= 0.15 + st * st * st;
      if (s > bs) { bs = s; best = i; }
    }
    host = best; tracked = host;
    // view from the sunward side of the wings: if the Sun is ahead along-track, sit ahead and look back
    const P = new THREE.Vector3(), F = new THREE.Vector3(); ecf(host, simT, P); ecf(host, simT + 1000, F); camSide = F.sub(P).dot(uSun.value) > 0 ? 1 : -1;
    onSelect({ ...meta[host], index: host, why: 'host' });
    for (const id of keepIds) { const i = meta.findIndex((m) => m.norad === id); if (i >= 0) { tracked = i; onSelect({ ...meta[i], index: i, why: 'decider' }); } }
  }

  // ── camera rig ──
  const camW = new THREE.Vector3(), hostP = new THREE.Vector3(), hostF = new THREE.Vector3(), T = new THREE.Vector3(), R = new THREE.Vector3(), B = new THREE.Vector3();
  const look = new THREE.Vector3(), tmp = new THREE.Vector3(), rightAx = new THREE.Vector3();
  let yaw = 0, pitch = 0, tYaw = 0, tPitch = 0, scrollK = 0, scrollS = 0, ease = 0;
  addEventListener('pointermove', (e) => { if (e.pointerType === 'touch') return; tYaw = -(e.clientX / innerWidth - 0.5) * 0.3; tPitch = -(e.clientY / innerHeight - 0.5) * 0.18; }, { passive: true });
  if (mobile) addEventListener('deviceorientation', (e) => { if (e.gamma == null) return; tYaw = -Math.max(-1, Math.min(1, e.gamma / 35)) * 0.16; tPitch = -Math.max(-1, Math.min(1, (e.beta - 50) / 35)) * 0.09; }, { passive: true });
  let elC = 9;
  function updateRig(t) {
    if (!ecf(host, simT, hostP) || !ecf(host, simT + 1000, hostF)) return false;
    R.copy(hostP).normalize(); T.subVectors(hostF, hostP); T.addScaledVector(R, -T.dot(R)).normalize(); B.crossVectors(T, R).normalize();
    scrollS += (scrollK - scrollS) * 0.06; const e = ease = scrollS * scrollS * (3 - 2 * scrollS);
    const a = t * 0.045, s = camSide;
    const back = (mobile ? 0.058 : 0.046) + 0.006 * Math.sin(a) + e * 900;
    const up = (mobile ? -0.027 : 0.0025) + 0.002 * Math.sin(a * 1.3) + e * 260;
    const side = (mobile ? 0 : s * (0.0105 + 0.0025 * Math.cos(a * 0.7))) - e * 60;
    // lift/lower the camera toward the sun-tracking wing normal so the cell faces are seen, not the edge
    const sn = uSun.value, nb = sn.dot(B), nT = (sn.dot(T) * s), nR = sn.dot(R), nl = Math.hypot(nT, nR) || 1;
    const elT = Math.max(-0.32, Math.min(0.32, Math.atan2(nR / nl, Math.max(nT / nl, 0.05)) * 0.75)) * (1 - e);
    elC += (elT - elC) * (Math.abs(elT - elC) > 0.6 ? 1 : 0.03);
    camW.copy(hostP).addScaledVector(T, s * back * Math.cos(elC)).addScaledVector(R, up + back * Math.sin(elC) * (1 - e)).addScaledVector(B, side);
    yaw += (tYaw - yaw) * 0.04; pitch += (tPitch - pitch) * 0.04;
    rightAx.copy(B).multiplyScalar(-s);
    const p0 = (mobile ? 0.2 : 0.06) - elC * 0.85 + pitch + 0.015 * Math.sin(a * 0.8);
    look.copy(T).multiplyScalar(-s).applyAxisAngle(rightAx, p0).applyAxisAngle(R, yaw + 0.05 * Math.sin(a * 0.5));
    tmp.copy(T).multiplyScalar(-s).applyAxisAngle(rightAx, 0.13).applyAxisAngle(R, yaw + 0.25);
    look.lerp(tmp, e).normalize();
    camera.position.set(0, 0, 0); camera.up.copy(R); camera.lookAt(look); camera.updateMatrixWorld();
    uCam.value.copy(camW); uC.value.copy(camW).negate();
    earthMat.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse); earthMat.uniforms.uCamWorld.value.copy(camera.matrixWorld);
    const gm = -gmstOf(simT); scene.backgroundRotation.set(0, gm, 0); starGroup.rotation.y = gm;
    rails.forEach((rr, k) => { rr.line.material.uniforms.uA.value = (k === 0 ? 0.36 : 0.12) * (1 + 4 * e); });
    return true;
  }
  let lastNear = 0;
  function refreshNear() {
    const v = new THREE.Vector3(), list = [], c2 = NEAR_KM * NEAR_KM;
    for (let i = 0; i < N; i++) { farPos(i, v); const d2 = v.distanceToSquared(camW); if (d2 < c2) list.push([d2, i]); }
    list.sort((x, y) => x[0] - y[0]);
    const nn = list.slice(0, K).map((x) => x[1]);
    if (!nn.includes(host)) { nn.pop(); nn.unshift(host); }
    if (tracked >= 0 && !nn.includes(tracked)) { nn.pop(); nn.push(tracked); }
    for (const i of near) hide[i] = 0; for (const i of nn) hide[i] = 1; satGeo.attributes.aHide.needsUpdate = true; near = nn;
  }
  let lastRails = 0;
  function refreshRails() {
    const g = SAT.gstime(new Date(simT)), pick = [host, ...near.filter((i) => i !== host).slice(0, RAILS - 1)];
    pick.forEach((i, r) => { const rr = rails[r]; if (!rr) return; rr.idx = i; const rc = rec(i), period = (2 * Math.PI / rc.no) * 60000;
      for (let k = 0; k <= RS; k++) { const pv = SAT.propagate(rc, new Date(simT + period * 0.5 * ((k / RS) * 2 - 1))); if (!pv || !pv.position) continue; const p = SAT.eciToEcf(pv.position, g); rr.world[k * 3] = p.x; rr.world[k * 3 + 1] = p.z; rr.world[k * 3 + 2] = -p.y; }
      rr.line.visible = true; });
  }

  // wing articulation: sun-tracking normal that periodically sweeps to the mirror angle → real-looking glints
  const nSun = new THREE.Vector3(), nHalf = new THREE.Vector3(), nW = new THREE.Vector3();
  const _gq = new URLSearchParams(location.search).get('glint'); const FORCE_GLINT = _gq == null ? null : Math.min(1, Math.max(0, +_gq || 0)); let HOST_PHASE = -1;
  function wingNormal(axis, toCam, sun, t, phase, out) {
    nSun.copy(sun).addScaledVector(axis, -sun.dot(axis)).normalize();
    nHalf.copy(sun).add(toCam); nHalf.addScaledVector(axis, -nHalf.dot(axis)).normalize();
    const f = FORCE_GLINT != null ? (phase === HOST_PHASE ? FORCE_GLINT : 0) : Math.pow(0.5 + 0.5 * Math.sin(t * 0.42 + phase), 10);
    return out.copy(nSun).lerp(nHalf, f).normalize();
  }
  const P = new THREE.Vector3(), PF = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), M4 = new THREE.Matrix4(), Mw = new THREE.Matrix4(), S3 = new THREE.Vector3(), Q = new THREE.Vector3();
  const relPos = new Map(), velOf = new Map(), camV = new THREE.Vector3(), qBody = new THREE.Quaternion(), invQ = new THREE.Quaternion();
  let heroGlint = 0; const heroGlintPos = new THREE.Vector3();
  function updateNear(t) {
    const gp = glGeo.attributes.position.array, gi = glGeo.attributes.aI.array, gs = glGeo.attributes.aSz.array;
    const sp = skGeo.attributes.position.array, sc = skGeo.attributes.color.array, sun = uSun.value;
    relPos.clear(); velOf.clear(); camV.copy(hostF).sub(hostP);
    let n = 0, gN = 0; heroGlint = 0; heroG.visible = false;
    for (let q = 0; q < near.length; q++) {
      const i = near[q];
      if (!ecf(i, simT, P) || !ecf(i, simT + 1000, PF)) continue;
      const rel = P.clone().sub(camW), d = rel.length(); relPos.set(i, rel); velOf.set(i, PF.clone().sub(P));
      const Ri = P.clone().normalize(), Ti = PF.clone().sub(P).normalize(), Bi = Ti.clone().cross(Ri).normalize();
      const lit = isLit(P, sun), toCam = rel.clone().negate().normalize();
      if (i === host) HOST_PHASE = i * 1.7; wingNormal(Bi, toCam, sun, t, i * 1.7, Y); Z.crossVectors(Bi, Y).normalize();
      if (i === host) {
        // high-detail model, true scale
        M4.makeBasis(Q.copy(Bi).negate(), Ri, Ti); qBody.setFromRotationMatrix(M4);
        heroG.visible = true; heroG.position.copy(rel); heroG.quaternion.copy(qBody);
        invQ.copy(qBody).invert(); const nl = Y.clone().applyQuaternion(invQ);
        const phi = Math.atan2(nl.z, nl.y); for (const w of hero.wings) w.rotation.x = phi;
        const refl = sun.clone().negate().reflect(Y), spec = lit ? Math.pow(Math.max(refl.dot(toCam), 0), 40) : 0; heroGlint = spec;
        for (let w = 0; w < 2; w++) { const gl = hero.glintLocal[w].clone().multiplyScalar(0.001).applyQuaternion(qBody).add(rel); gp.set([gl.x, gl.y, gl.z], (K + w) * 3); gi[K + w] = spec * 1.4; gs[K + w] = 30 + 260 * spec; }
        heroGlintPos.copy(hero.glintLocal[1]).multiplyScalar(0.001).applyQuaternion(qBody).add(rel);
        continue;
      }
      const enl = 1 + Math.max(0, (0.13 * Math.sqrt(d)) / 0.027 - 1) * THREE.MathUtils.smoothstep(d, 0.3, 3);
      M4.makeBasis(Q.copy(Bi).negate(), Ri, Ti); M4.scale(S3.set(enl, enl, enl)); M4.setPosition(rel); nbBodies.setMatrixAt(n, M4);
      Mw.makeBasis(Bi, Y, Z); Mw.scale(S3); Mw.setPosition(rel); nbWings.setMatrixAt(n, Mw);
      const shade = lit ? 1 : 0.4; nbBodies.instanceColor.setXYZ(n, shade, shade, shade); nbWings.instanceColor.setXYZ(n, shade, shade, shade);
      const refl = sun.clone().negate().reflect(Y), spec = lit ? Math.pow(Math.max(refl.dot(toCam), 0), 24) : 0;
      gp.set([rel.x, rel.y, rel.z], n * 3); gi[n] = lit ? Math.min(1.8, 0.7 + spec * 2.4) : 0.06; gs[n] = (22 + 140 * spec) / (1 + d / 400) + 10;
      const vrel = PF.clone().sub(P).sub(camV), ex = Math.min(0.5 * Math.max(warp, 1), 40), tail = rel.clone().addScaledVector(vrel, -ex);
      sp.set([rel.x, rel.y, rel.z, tail.x, tail.y, tail.z], n * 6); const sb = lit && d > 0.5 ? Math.min(0.55, 60 / d) : 0; sc.set([sb * .8, sb * .9, sb, 0, 0, 0], n * 6);
      n++;
    }
    for (let k = n; k < K; k++) gi[k] = 0;
    for (const m of [nbBodies, nbWings]) { m.count = n; m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; }
    glGeo.attributes.position.needsUpdate = glGeo.attributes.aI.needsUpdate = glGeo.attributes.aSz.needsUpdate = true;
    skGeo.setDrawRange(0, n * 2); skGeo.attributes.position.needsUpdate = skGeo.attributes.color.needsUpdate = true;
    for (const rr of rails) { if (!rr.line.visible) continue; const a = rr.line.geometry.attributes.position.array;
      for (let k = 0; k < a.length; k += 3) { a[k] = rr.world[k] - camW.x; a[k + 1] = rr.world[k + 1] - camW.y; a[k + 2] = rr.world[k + 2] - camW.z; } rr.line.geometry.attributes.position.needsUpdate = true; }
    sunLight.position.copy(sun).multiplyScalar(10); sunLight.target.position.set(0, 0, 0);
    // earthshine only on the day side, from below
    earthShine.position.copy(R); earthShine.intensity = 0.25 + 0.9 * Math.max(0, R.dot(sun) + 0.2);
    sunLight.intensity = isLit(hostP, sun) ? 2.6 : 0.0;
  }

  // flare: real sun position on screen (if not behind Earth) + hero wing glint
  const sv = new THREE.Vector3();
  function updateFlare() {
    if (!final) return;
    const sun = uSun.value; let vis = 0;
    const E = uC.value, tt = E.dot(sun); const occl = tt > 0 && E.clone().addScaledVector(sun, -tt).lengthSq() < (RE + 20) ** 2;
    sv.copy(sun).multiplyScalar(1000).project(camera);
    const cz = sun.clone().applyMatrix4(camera.matrixWorldInverse).z;
    if (!occl && cz < 0 && Math.abs(sv.x) < 1.3 && Math.abs(sv.y) < 1.3) vis = 1 - Math.max(0, Math.max(Math.abs(sv.x), Math.abs(sv.y)) - 1) / 0.3;
    final.uniforms.uSunVis.value = vis * 0.9; final.uniforms.uSunUV.value.set(sv.x * .5 + .5, sv.y * .5 + .5);
    const hp = heroGlintPos.clone().project(camera);
    final.uniforms.uFlareI.value = heroG.visible ? Math.min(1, heroGlint * 1.6) : 0; final.uniforms.uFlareUV.value.set(hp.x * .5 + .5, hp.y * .5 + .5);
  }

  // tour among on-screen neighbours
  let tourAt = performance.now() + 9000, userHold = 0, lastDetail = 0;
  // screen-space circle covering the ridden satellite (so the data layer never sits on it)
  function heroRect() {
    if (!heroG.visible) return null; const pts = [];
    for (const sx of [-1, 1]) { const v = new THREE.Vector3(sx * hero.span * 0.5, 0, 0).multiplyScalar(0.001).applyQuaternion(heroG.quaternion).add(heroG.position).project(camera); if (v.z < 1) pts.push(v); }
    const c = heroG.position.clone().project(camera); pts.push(c);
    const xs = pts.map((p) => (p.x * .5 + .5) * innerWidth), ys = pts.map((p) => (-p.y * .5 + .5) * innerHeight);
    return { x0: Math.min(...xs) - 60, x1: Math.max(...xs) + 60, y0: Math.min(...ys) - 80, y1: Math.max(...ys) + 80 };
  }
  function onScreen(i, margin = 0.75) { const r = relPos.get(i); if (!r) return null; const c = r.clone().applyMatrix4(camera.matrixWorldInverse); if (c.z > -0.01) return null; const p = r.clone().project(camera); if (Math.abs(p.x) > margin || Math.abs(p.y) > margin) return null; return { x: (p.x * .5 + .5) * innerWidth, y: (-p.y * .5 + .5) * innerHeight, d: r.length() }; }
  function tour(now) {
    if (now < tourAt || now < userHold) return; tourAt = now + 8500;
    if (keepIds.size && meta[tracked] && keepIds.has(meta[tracked].norad)) return;
    const cand = near.filter((i) => onScreen(i)); if (!cand.length) return;
    tracked = cand[(Math.random() * Math.min(cand.length, 8)) | 0]; lastDetail = 0; onSelect({ ...meta[tracked], index: tracked, why: tracked === host ? 'host' : 'near' });
  }
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || host < 0) return; const mv = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null; if (mv > 6) return;
    let best = -1, bd = (mobile ? 26 : 16) ** 2; const v = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const r = relPos.get(i) || farPos(i, v).clone().sub(camW); const c = r.clone().applyMatrix4(camera.matrixWorldInverse); if (c.z > 0) continue;
      const d = r.length(), E = uC.value.clone(), dir = r.clone().divideScalar(d), tt = E.dot(dir); if (tt > 0 && tt < d && E.sub(dir.multiplyScalar(tt)).lengthSq() < RE * RE) continue;
      const p = r.clone().project(camera), sx = (p.x * .5 + .5) * innerWidth, sy = (-p.y * .5 + .5) * innerHeight, dd = (sx - e.clientX) ** 2 + (sy - e.clientY) ** 2;
      if (dd < bd) { bd = dd; best = i; }
    }
    if (best >= 0) { tracked = best; userHold = performance.now() + 30000; lastDetail = 0; if (!near.includes(best)) { near.pop(); near.push(best); hide[best] = 1; satGeo.attributes.aHide.needsUpdate = true; } onSelect({ ...meta[best], index: best, why: 'user' }); }
  });

  function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); buildComposer(); }
  addEventListener('resize', resize); resize();

  // live stats for the data layer (computed from the propagated far field)
  const stats = { sunlit: 0, shadow: 0, at: 0 };
  function computeStats() { const v = new THREE.Vector3(), sun = uSun.value; let l = 0; for (let i = 0; i < N; i++) { farPos(i, v); if (v.lengthSq() < 1) continue; if (isLit(v, sun)) l++; } stats.sunlit = l; stats.shadow = N - l; stats.at = simT; }
  let stateHash = '', hashBusy = false;
  async function computeStateHash() {
    if (hashBusy || !posB) return; hashBusy = true;
    try { const q = new Int32Array(posB.length); for (let i = 0; i < q.length; i++) q[i] = Math.round(posB[i]);
      const h = await crypto.subtle.digest('SHA-256', q.buffer); stateHash = [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join(''); api.stateHashAt = tB; } catch {}
    hashBusy = false;
  }

  // auto quality tiers
  let fpsN = 0, fpsT0 = 0, fpsChecks = 0;
  function autoTier(now) {
    if (forced) return; if (!fpsT0) { fpsT0 = now; fpsN = 0; return; } fpsN++;
    if (now - fpsT0 < 2500) return; const fps = fpsN / ((now - fpsT0) / 1000); fpsT0 = now; fpsN = 0; fpsChecks++; api.fps = fps;
    if (fpsChecks > 6) return;
    if (tier === 'high' && fps < 45) { tier = 'medium'; buildComposer(); }
    else if (tier === 'medium' && fps < 28) { tier = 'low'; buildComposer(); }
    api.tier = tier;
  }

  const clock = new THREE.Clock(); let visible = true, first = false, lastStats = 0, lastHash = 0, lastEnv = 0;
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; if (visible) { clock.getDelta(); fpsT0 = 0; loop(); } });
  function loop() {
    if (!visible) return; requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime, now = performance.now();
    simT += dt * 1000 * warp; uTime.value = t; uSun.value.copy(sunDir(simT));
    if (ready) {
      if (simT >= tB && queued) { posA.set(posB); tA = tB; posB.set(queued.pos); tB = queued.t; queued = null; satGeo.attributes.posA.needsUpdate = satGeo.attributes.posB.needsUpdate = true; }
      if (!queued && !inflight && simT > tA) want(tB + stepFor(warp));
      satMat.uniforms.uMix.value = Math.min(Math.max((simT - tA) / (tB - tA), 0), 1);
    }
    let live = false;
    if (ready && SAT && host >= 0 && updateRig(t)) {
      live = true;
      if (now - lastEnv > 4000) { lastEnv = now; updateEnv(R.clone()); }
      if (now - lastNear > (warp > 1 ? 150 : 400)) { lastNear = now; refreshNear(); }
      if (now - lastRails > (warp > 1 ? 1000 : 2500)) { lastRails = now; refreshRails(); }
      if (now - lastStats > 2000) { lastStats = now; computeStats(); }
      if (now - lastHash > 5000) { lastHash = now; computeStateHash(); }
      updateNear(t); updateFlare(); tour(now);
      const r = relPos.get(tracked);
      if (r && api.onLabel) { const c = r.clone().applyMatrix4(camera.matrixWorldInverse), p = r.clone().project(camera); api.onLabel((p.x * .5 + .5) * innerWidth, (-p.y * .5 + .5) * innerHeight, c.z > 0 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05, r.length()); }
      if (now - lastDetail > 500 && tracked >= 0) { lastDetail = now; const g = api.geo(tracked); if (g) onDetail({ ...meta[tracked], ...g, camAlt: camW.length() - RE, host: meta[host].name }); }
      if (!first) { first = true; requestAnimationFrame(() => requestAnimationFrame(onFirstFrame)); }
      autoTier(now);
    }
    if (final) final.uniforms.uTime.value = t;
    composer.render();
    if (live && api.onFrame) api.onFrame(t);
  }
  loop();

  const api = {
    info: null, tier, fps: 0, stateHashAt: 0,
    load(text) { worker.postMessage({ type: 'init', text, max, keep, t: simT }); },
    setWarp(w) { warp = w; resetKeys(); },
    selectNorad(id) { const i = meta.findIndex((m) => m.norad === +id); if (i >= 0) { tracked = i; onSelect({ ...meta[i], index: i, why: 'decider' }); } return i; },
    get simT() { return simT; }, get N() { return N; }, get near() { return near; }, get tracked() { return tracked; }, get host() { return host; },
    get glint() { return heroGlint; }, get meta() { return meta; }, get stats() { return stats; }, get stateHash() { return stateHash; }, get scroll() { return ease; }, get mobile() { return mobile; }, get tierNow() { return tier; },
    setScroll(k) { scrollK = k; },
    onScreen, heroRect,
    // real geodetic + speed + range for satellite i at the current sim time
    geo(i) {
      const d = new Date(simT), pv = SAT.propagate(rec(i), d); if (!pv || !pv.position) return null;
      const geo = SAT.eciToGeodetic(pv.position, SAT.gstime(d)), v = pv.velocity, Pw = new THREE.Vector3(); ecf(i, simT, Pw);
      return { lat: SAT.degreesLat(geo.latitude), lon: SAT.degreesLong(geo.longitude), alt: geo.height, vel: Math.hypot(v.x, v.y, v.z), range: Pw.distanceTo(camW), lit: isLit(Pw, uSun.value) };
    },
    // linear closest-approach estimate among near satellites (relative state from SGP4)
    nextPass() {
      let best = null;
      for (const i of near) { if (i === host) continue; const r = relPos.get(i), v = velOf.get(i); if (!r || !v) continue; const vr = v.clone().sub(camV), vv = vr.lengthSq(); if (vv < 1e-6) continue;
        const tca = -r.dot(vr) / vv; if (tca <= 0 || tca > 900) continue; const miss = r.clone().addScaledVector(vr, tca).length();
        if (!best || tca < best.tca) best = { i, name: meta[i].name, norad: meta[i].norad, tca, miss, vrel: Math.sqrt(vv) }; }
      return best;
    },
    onLabel: null, onFrame: null,
  };
  return api;
}
