// DNA homepage scene as a mountable module.
// mountDNA(root, opts) builds the WebGL journey inside `root` (canvas + overlay sections marked with data-*),
// drives it from window scroll, and returns destroy(), which stops every loop and listener and frees the GPU.
// simplification: plain JS, kept line for line with the reference implementation of this scene so the visuals can't drift;
// typing 1,000 lines of shader plumbing buys nothing here. The React wrapper (DNA.tsx) owns the types.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// text boxes the particles must never cover (shader masks) and the glyph runs the pixel QA checks
const TEXT_BOXES = "[data-head] h1, [data-head] [data-col], [data-end], [data-organ] h2, [data-organ] p";
const QA_TEXT = "[data-head] h1, [data-head] p, [data-end] [data-big], [data-end] a, [data-organ] h2, [data-organ] p";

/** @param {HTMLElement} root @param {{ font: string, demo: boolean, debug: boolean, onReady: () => void }} opts */
export function mountDNA(root, { font, demo, debug, onReady }) {
let dead = false, raf = 0;
const timers = [], offs = [];
const on = (t, ev, fn) => { t.addEventListener(ev, fn); offs.push(() => t.removeEventListener(ev, fn)); };
const mobile = matchMedia("(max-width: 760px)").matches;
// desktop framing is designed between 16:10 and 2:1: narrower windows keep the 16:10 width (the camera widens), wider ones
// keep the 2.2:1 width (the camera zooms in and crops top/bottom), so the subject never shrinks into an ultrawide's middle
const spanAspect = () => Math.min(2.2, Math.max(1.6, innerWidth / innerHeight));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(11), gauss = () => (R() + R() + R() - 1.5) * 0.8;

const NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy; i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw); vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3))); p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){ float a=.5, s=0.; for(int i=0;i<4;i++){ s+=a*snoise(p); p*=2.03; a*=.5; } return s; }`;

// ---------- renderer ----------
const canvas = root.querySelector("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
const DPR = Math.min(devicePixelRatio, mobile ? 1.5 : 1.75);
renderer.setPixelRatio(DPR);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
// soft, coloured studio for reflections: no hard boxes, just glowing washes (the glass reads as glass, not as a mirror of a room)
{
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: `varying vec3 vD; void main(){ vD=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `varying vec3 vD;
      float blob(vec3 d, vec3 c, float w){ return pow(max(dot(d,normalize(c)),0.), w); }
      void main(){ vec3 d=normalize(vD);
        vec3 c=vec3(.01,.012,.016);
        c+=vec3(1.,1.,1.)*blob(d,vec3(-.3,1.,.4),24.)*2.2;
        c+=vec3(.25,.9,.85)*blob(d,vec3(-1.,.2,.3),6.)*1.1;
        c+=vec3(1.,.35,.7)*blob(d,vec3(1.,-.1,.2),6.)*1.0;
        c+=vec3(.5,.4,1.)*blob(d,vec3(.2,-1.,-.3),5.)*.8;
        c+=vec3(1.,.75,.4)*blob(d,vec3(.6,.4,-1.),8.)*.6;
        gl_FragColor=vec4(c,1.); }`,
  })));
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
}
const camera = new THREE.PerspectiveCamera(mobile ? 50 : 38, 1, 0.05, 200);

// no point lights: their pin-sharp highlights bloom into square blocks; the coloured environment lights everything

// ---------- materials ----------
const glass = (tint = "#d9f3ff") => new THREE.MeshPhysicalMaterial({
  color: tint, metalness: 0, roughness: 0.02, transmission: 1, thickness: 0.45, ior: 1.3, specularIntensity: 0.6,
  iridescence: 1, iridescenceIOR: 1.6, iridescenceThicknessRange: [120, 780], clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 0.55,
});
const chrome = new THREE.MeshPhysicalMaterial({
  color: "#7d7590", metalness: 1, roughness: 0.32, iridescence: 1, iridescenceIOR: 2.1, iridescenceThicknessRange: [250, 1200],
  clearcoat: 0.4, clearcoatRoughness: 0.3, envMapIntensity: 0.9,
});

// ---------- the helix: a double helix made of light ----------
// Soft bokeh motes (the same family as the flower clusters) trace B-DNA: 10.5 base pairs a turn, offset strands for the
// major/minor grooves, a loose aura around it. Additive, depth-of-field sized, never opaque: it should glow, not look moulded.
const SPINE = { top: 3.6 };                                    // where the cards (and their mutations) begin
const DNA = { top: 14, bottom: -41, r: 0.95, rise: 0.16, perTurn: 10.5, groove: 2.35 };
const SPINE_BOTTOM = -10.8;                                     // the rule cards end here; the utility organs live below
const NBP = Math.floor((DNA.top - DNA.bottom) / DNA.rise);
const PET = { lilac: "#cdb6ff", violet: "#8a5cf0", deep: "#5b3bc4", magenta: "#d24aa8", rose: "#ff86bb", coral: "#ff9b8f", teal: "#4fd6c8", ice: "#bfe9ff" };
const BASECOL = { A: ["#4fd6c8", "#86eadf"], T: ["#ff86bb", "#ffb0cf"], G: ["#d24aa8", "#ec6cc2"], C: ["#8a5cf0", "#b195ff"] };
const PAIRS = [["A", "T"], ["T", "A"], ["G", "C"], ["C", "G"]];
const seq = Array.from({ length: NBP }, () => (R() * 4) | 0);
const mutant = seq.map((b) => (b + 1 + ((R() * 3) | 0)) % 4);

const DQ = mobile ? 0.45 : 1;
const STRAND_PER_BP = Math.round(150 * DQ), RUNG_PER_HALF = Math.round(44 * DQ), AURA_PER_BP = Math.round(26 * DQ);
const total = NBP * (2 * STRAND_PER_BP + 2 * RUNG_PER_HALF + AURA_PER_BP);
const aI = new Float32Array(total), aKind = new Float32Array(total), aU = new Float32Array(total), aSize = new Float32Array(total);
const aOff = new Float32Array(total * 3), aScat = new Float32Array(total * 3), aCol = new Float32Array(total * 3), aCol2 = new Float32Array(total * 3), aRnd = new Float32Array(total);
const _c = new THREE.Color(), _c2 = new THREE.Color();
const pick = (arr) => arr[(R() * arr.length) | 0];
const dir3 = () => new THREE.Vector3(gauss(), gauss(), gauss()).normalize();
let n = 0;
for (let i = 0; i < NBP; i++) {
  const pr = PAIRS[seq[i]], pm = PAIRS[mutant[i]];
  for (let s = 0; s < 2; s++) {
    // strand: a fluffy cord, dense at its core and thinning outward
    const heads = [0, 1, 2, 3].map(() => ({ t: R(), c: dir3().multiplyScalar(0.03 + R() * 0.08), r: 0.08 + R() * 0.09 }));
    for (let k = 0; k < STRAND_PER_BP; k++, n++) {
      const h = heads[(R() * heads.length) | 0];
      aI[n] = i + h.t; aKind[n] = s;
      const v = dir3().multiplyScalar(h.r * Math.pow(R(), 0.8) * (R() < 0.08 ? 2 : 1)); // a few strays drift off the cord
      aOff.set([h.c.x + v.x, (h.c.y + v.y) * 0.7, h.c.z + v.z], n * 3);
      _c.set(pick([PET.lilac, PET.violet, PET.deep, PET.violet, PET.magenta, PET.magenta, PET.rose, PET.coral, PET.lilac]));
      _c.offsetHSL((R() - 0.5) * 0.05, (R() - 0.5) * 0.12, (R() - 0.5) * 0.14);
      aCol.set([_c.r, _c.g, _c.b], n * 3); aCol2.set([_c.r, _c.g, _c.b], n * 3);
      aSize[n] = 0.02 + Math.pow(R(), 2.6) * 0.05;
      const w = dir3(); aScat.set([w.x, w.y, w.z], n * 3);
      aRnd[n] = R();
    }
    // base pair: a dotted bridge to the middle, coloured by base and by what it mutates into
    for (let k = 0; k < RUNG_PER_HALF; k++, n++) {
      aI[n] = i; aKind[n] = 2 + s; aU[n] = R();
      aOff.set([gauss() * 0.06, gauss() * 0.04, gauss() * 0.06], n * 3);
      _c.set(pick(BASECOL[pr[s]])); _c2.set(pick(BASECOL[pm[s]]));
      aCol.set([_c.r, _c.g, _c.b], n * 3); aCol2.set([_c2.r, _c2.g, _c2.b], n * 3);
      aSize[n] = 0.018 + Math.pow(R(), 2.4) * 0.04;
      const w = dir3(); aScat.set([w.x, w.y, w.z], n * 3);
      aRnd[n] = R();
    }
  }
  // aura: loose motes drifting around the helix, giving it air and depth
  for (let k = 0; k < AURA_PER_BP; k++, n++) {
    aI[n] = i + R(); aKind[n] = 4;
    const hk = (i * 7 + ((R() * 3) | 0)) % 97, hr = rng(hk + 1);
    const rr = DNA.r * (1.6 + hr() * 1.6), th = hr() * Math.PI * 2, v = dir3().multiplyScalar(0.08 + Math.pow(R(), 0.5) * 0.14);
    aOff.set([Math.cos(th) * rr + v.x, (hr() - 0.5) * DNA.rise * 3 + v.y, Math.sin(th) * rr + v.z], n * 3);
    _c.set(pick([PET.lilac, PET.violet, PET.magenta, PET.rose, PET.coral, PET.deep, PET.teal]));
    _c.offsetHSL((R() - 0.5) * 0.05, 0, (R() - 0.5) * 0.12);
    aCol.set([_c.r, _c.g, _c.b], n * 3); aCol2.set([_c.r, _c.g, _c.b], n * 3);
    aSize[n] = 0.022 + Math.pow(R(), 2.5) * 0.05;
    const w = dir3(); aScat.set([w.x, w.y, w.z], n * 3);
    aRnd[n] = R();
  }
}
const dGeo = new THREE.BufferGeometry();
dGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(total * 3), 3));
[["aI", aI, 1], ["aKind", aKind, 1], ["aU", aU, 1], ["aSize", aSize, 1], ["aOff", aOff, 3], ["aScat", aScat, 3], ["aCol", aCol, 3], ["aCol2", aCol2, 3], ["aRnd", aRnd, 1]]
  .forEach(([k, a, w]) => dGeo.setAttribute(k, new THREE.BufferAttribute(a, w)));
const maskU = { uMask: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) }, uMaskN: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } };
const MAXS = 8;
const dnaU = {
  uTime: { value: 0 }, uPR: { value: DPR }, uViewH: { value: 1 }, uFocus: { value: 7 },
  uTop: { value: DNA.top }, uRise: { value: DNA.rise }, uR: { value: DNA.r }, uPerTurn: { value: DNA.perTurn }, uGroove: { value: DNA.groove }, uNBP: { value: NBP },
  uSiteI0: { value: new Float32Array(MAXS).fill(-99) }, uSiteM: { value: new Float32Array(MAXS) }, uSiteAway: { value: new Float32Array(MAXS) },
  ...maskU, uMobile: { value: mobile ? 1 : 0 },
};
const dna = new THREE.Points(dGeo, new THREE.ShaderMaterial({
  uniforms: dnaU, transparent: true, depthWrite: false,
  vertexShader: `
    uniform float uTime, uPR, uViewH, uFocus, uTop, uRise, uR, uPerTurn, uGroove, uNBP;
    uniform float uSiteI0[${MAXS}], uSiteM[${MAXS}]; uniform float uMobile;
    attribute float aI, aKind, aU, aSize, aRnd; attribute vec3 aOff, aScat, aCol, aCol2;
    uniform vec4 uMask[6]; uniform float uMaskN; uniform vec2 uRes;
    // text never sits on particles: background motes inside a visible text box (padded by the mote's own size) vanish
    float textMask(vec4 clip, float sizePx){
      vec2 uv = clip.xy/clip.w*.5 + .5; uv.y = 1. - uv.y;
      vec2 pad = vec2(sizePx*.5 + 12.)/uRes;
      float k = 1.;
      for (int i = 0; i < 6; i++) {
        if (float(i) >= uMaskN) break;
        vec4 r = uMask[i];
        vec2 lo = r.xy - pad, hi = r.zw + pad;
        k *= 1. - step(lo.x, uv.x)*step(uv.x, hi.x)*step(lo.y, uv.y)*step(uv.y, hi.y);
      }
      return k;
    }
    varying vec3 vC; varying float vA, vCoc;
    // key light from the upper right (in view space, so every shot is lit the same way), a rim on the silhouette, haze with depth
    float keyLight(vec3 n, float d){
      vec3 nV = normalize((modelViewMatrix*vec4(n, 0.)).xyz);
      float key = max(dot(nV, normalize(vec3(.55, .55, .62))), 0.), rim = pow(1. - abs(nV.z), 3.);
      return (.56 + .72*key + .36*rim)*(1. - .42*smoothstep(uFocus + 2., uFocus + 16., d));
    }
    vec3 strand(float i, float s){
      float unzip = smoothstep(uNBP-30., uNBP-1., i), top = 1.-smoothstep(0., 18., i);
      float r = uR*(1.+unzip*1.)*(1.-top*.5);
      float a = i/uPerTurn*6.28318 + uTime*.12 + s*(uGroove + unzip*.9);
      return vec3(cos(a)*r, uTop - i*uRise + (s>.5 ? .3 : -.3)*unzip, sin(a)*r);
    }
    void main(){
      float i = aI, s = mod(aKind, 2.);
      vec3 p; float size = aSize, bright = 1.;
      if (aKind < 1.5) {
        p = strand(i, s) + aOff;
      } else if (aKind < 3.5) {
        vec3 A = strand(i, s), B = strand(i, 1.-s), mid = (A+B)*.5;
        float gap = smoothstep(uNBP-30., uNBP-8., i);
        p = mix(A, mid, aU*(.93 - gap*.9)) + aOff;
        bright = 1.15;
      } else {
        vec3 c = strand(i, 0.); c.x = 0.; c.z = 0.;
        float a = uTime*.05*(.5 + aRnd);
        p = c + vec3(aOff.x*cos(a) - aOff.z*sin(a), aOff.y, aOff.x*sin(a) + aOff.z*cos(a));
        bright = .4;
      }
      // everything breathes slowly, like something alive
      p += aScat*(.03 + .035*aRnd)*sin(uTime*(.45 + aRnd*.5) + aRnd*40.);   // float, don't sit
      // mutation: a wave of light runs through the gene, its bases change colour behind the wave, the cut rings flash
      vC = aCol;
      float glow = 0., bp = floor(i);
      for (int k = 0; k < ${MAXS}; k++) {
        float i0 = uSiteI0[k];
        if (aKind < 3.5 && bp >= i0 - 1. && bp < i0 + 7.) {
          float m = uSiteM[k];
          float w = (i - i0) / 6.;
          float front = (m - .22) / .5;                       // the wave's position along the gene
          glow += exp(-(w - front)*(w - front)*40.) * step(.18, m) * (1. - step(.85, m)) * 2.2;
          float turn = smoothstep(0., .25, front - w - aRnd*.15);
          vC = mix(aCol, aCol2, turn);
          glow += smoothstep(0., .15, m) * (1. - smoothstep(.85, 1., m)) * .35;
          size *= 1. + .35*exp(-(w - front)*(w - front)*40.);
        }
      }
      size *= 1. - (1. - smoothstep(0., 18., i))*.5;
      vec4 mv = modelViewMatrix*vec4(p, 1.);
      float d = -mv.z;
      vCoc = clamp(abs(d - uFocus)*.03, 0., .12);
      gl_PointSize = (size + vCoc)*uViewH/d;
      gl_Position = projectionMatrix*mv;
      vA = clamp(bright, 0., 1.)*(.5 + .35*aRnd) / (1. + vCoc*vCoc*120.);
      if (aKind > 3.5 || uMobile > .5) vA *= textMask(gl_Position, gl_PointSize); // phones: the text owns its box, the helix steps back
      vC = vC*(1. + glow)*keyLight(aKind < 1.5 ? aOff + 1e-4 : vec3(p.x, 0., p.z) + 1e-4, d) + glow*.35;
    }`,
  fragmentShader: `
    varying vec3 vC; varying float vA, vCoc;
    void main(){
      float d = length(gl_PointCoord - .5)*2.;
      if (d > 1.) discard;
      // a translucent petal: even colour, a soft slightly darker outline, edges anti-aliased
      float edge = smoothstep(.72, .97, d);
      vec3 col = vC*(1. - edge*.32);
      float a = vA*(1. - smoothstep(.93, 1., d))*(.85 + edge*.25);
      gl_FragColor = vec4(col, a);
    }`,
}));
dna.frustumCulled = false;
scene.add(dna);

// mutation sites: one gene segment beside each card, cut by two laser rings as the camera passes
const SITE_LEN = 6;
const sites = [];
const ringGeo = new THREE.TorusGeometry(DNA.r * 1.9, 0.008, 8, 128);
function addSite(y, k, awayAngle) {
  const i0 = clamp(Math.round((DNA.top - y) / DNA.rise) - (SITE_LEN >> 1), 1, NBP - SITE_LEN - 2);
  const rings = [0, 1].map(() => {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: "#f3e8ff", transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.rotation.x = Math.PI / 2; scene.add(m); return m;
  });
  dnaU.uSiteI0.value[k] = i0; dnaU.uSiteAway.value[k] = awayAngle;
  sites.push({ i0, y, k, rings });
}
function updateDNA(t, camY) {
  dnaU.uTime.value = t;
  sites.forEach((s) => {
    const m = sstep(s.y + 1.4, s.y - 0.7, camY);
    dnaU.uSiteM.value[s.k] = m;
    const flash = sstep(0.14, 0.26, m) * (1 - sstep(0.32, 0.46, m)) + sstep(0.8, 0.87, m) * (1 - sstep(0.88, 0.97, m));
    s.rings.forEach((ring, e) => {
      ring.position.set(0, DNA.top - (s.i0 + (e ? SITE_LEN : 0) - 0.5) * DNA.rise, 0);
      ring.material.opacity = flash;
      ring.scale.setScalar(0.85 + flash * 0.25);
    });
  });
}

// ---------- the camera journey ----------
// control points: [camera position, look target, scroll weight to reach the next point]
const PATH = [
  [[0, 8.3, 7.4], [0, 7.8, 0], 1.0],      // hero: the helix
  [[3.4, 8.9, 6.0], [0, 7.6, 0], 1.0],    // orbit
  [[2.2, 8.0, mobile ? 7.4 : 6.2], [mobile ? -2.3 : -2.4, 8.0, 0], 1.6], // close: headline beside the helix
  [[-0.6, 6.4, 6.4], [0, 4.6, 0], 1.0],   // tilt down the helix to where the genes begin
];
// down the spine, slowly circling it so the cards swing past
const SPIN = (y) => -0.35 + (SPINE.top - y) * 0.42;
const spineStops = [];
for (let y = SPINE.top - 0.4; y >= SPINE_BOTTOM + 0.6; y -= 1.35) spineStops.push(y);
spineStops.forEach((y) => { const a = SPIN(y), r = mobile ? 10 : 9; PATH.push([[Math.sin(a) * r, y + 0.7, Math.cos(a) * r], [0, y - 0.15, 0], 1.0, true]); });
const ROOT_Y = DNA.bottom - 0.2;
// utility organs: each grows off the helix below the cards; the camera faces it straight on, the helix behind it
const ORGANS = ["vote", "jackpot", "streak", "rewards", "mystery"].map((type, k) => {
  const y = -15 - k * 5.4, theta = SPIN(SPINE_BOTTOM) + 1.2 + k * 1.35;
  const dir = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));
  const centre = type === "streak" ? new THREE.Vector3(0, y, 0) : dir.clone().multiplyScalar(3.4).setY(y);
  const D = mobile ? 13.5 : type === "streak" ? 8.6 : 7.4;
  const cam = centre.clone().addScaledVector(dir, D).add(new THREE.Vector3(0, type === "streak" ? 2.4 : 0.5, 0));
  const right = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
  const tanH = Math.tan(THREE.MathUtils.degToRad((mobile ? 50 : 38) / 2)) * (mobile ? innerWidth / innerHeight : spanAspect());
  const look = mobile ? centre.clone().add(new THREE.Vector3(0, 2.3, 0)) : centre.clone().addScaledVector(right, -0.5 * D * tanH);
  const stop = PATH.length;
  PATH.push([cam.toArray(), look.toArray(), 1.9]);
  return { type, k, y, theta, dir, centre, cam, stop };
});
PATH.push([[3.2, ROOT_Y - 1.6, 6.8], [0, ROOT_Y - 2.6, 0], 1.0]);  // into the roots
{ const D = mobile ? 18 : 12, tanH = Math.tan(THREE.MathUtils.degToRad((mobile ? 50 : 38) / 2)) * (mobile ? innerWidth / innerHeight : spanAspect());
  PATH.push([[0, ROOT_Y - 1.2, D], [mobile ? 0 : -0.48 * D * tanH, mobile ? ROOT_Y - 1.2 : ROOT_Y - 1.7, 0], 1.6]); } // roots framed right, title left
PATH.push([[0, -12, 62], [0, -12, 0], 1.4]);                       // pull back: the whole helix, organs and roots
PATH.push([[0, 8.3, mobile ? 8.6 : 7.4], [mobile ? -2.4 : -1.6, 7.8, 0], 0]);    // home: the helix on the right, the way out on the left
const camCurve = new THREE.CatmullRomCurve3(PATH.map((p) => new THREE.Vector3(...p[0])), false, "centripetal");
const lookCurve = new THREE.CatmullRomCurve3(PATH.map((p) => new THREE.Vector3(...p[1])), false, "centripetal");
const W = PATH.map((p) => p[2]); const Wsum = W.slice(0, -1).reduce((a, b) => a + b, 0);
// scroll progress → curve parameter, honouring each segment's weight
function pathU(p) {
  let acc = 0; const n = PATH.length - 1;
  for (let k = 0; k < n; k++) {
    const w = W[k] / Wsum;
    if (p <= acc + w || k === n - 1) { const f = clamp((p - acc) / w, 0, 1); const e = PATH[k][3] && PATH[k + 1][3] ? f : f * f * (3 - 2 * f); return (k + e) / n; }
    acc += w;
  }
  return 1;
}
// the scroll progress at which the camera arrives at control point k
const arrive = (k) => W.slice(0, k).reduce((a, b) => a + b, 0) / Wsum;
if (debug) Object.assign(window, { __arrive: arrive, __n: PATH.length });
// 1 while the camera holds on stop k: fades in over the end of the approach, out once it is well on its way to the next stop
const holdOn = (k, inF, outA, outB) => { const a = arrive(k), wp = W[k - 1] / Wsum, wn = W[k] / Wsum; return sstep(a - wp * inF, a, sp) * (1 - sstep(a + wn * outA, a + wn * outB, sp)); };


// ---------- cards: the eight essentials, orbiting the spine ----------
const CARDS = [
  ["The fee", "Tuned by an AI", "It reads the market every 15 minutes and proposes a better fee when it finds one.", ["#1b6f8a", "#57e0c7", "#e9fff6"]],
  ["The cap", "5% maximum", "Written into the contract, from the end of the launch tax. Nobody can ever raise it.", ["#5a1640", "#ff5fae", "#ffd1e6"]],
  ["The delay", "1 hour in public", "Every AI change waits an hour in public. The Safe can cancel it.", ["#2c1f6e", "#7a5cff", "#d9d2ff"]],
  ["The brake", "Instant rollback", "A test that hurts trading is undone right away.", ["#6a3410", "#ffb347", "#fff0d6"]],
  ["The owner", "There is none", "The token and its hook can't be upgraded, paused or changed.", ["#123a2c", "#5fffb0", "#e2fff1"]],
  ["The record", "Every step public", "Each step is signed in a sealed machine and anchored on Ethereum.", ["#3a1b5e", "#c77dff", "#f3e6ff"]],
  ["The fees", "Fees feed it", "Buyback and burn, deeper liquidity, a treasury and the games.", ["#5e1a1a", "#ff6b5f", "#ffe2dc"]],
  ["The leash", "Freedom is earned", "The AI gets more control one level at a time. Only the Safe can raise its level.", ["#103a5e", "#5fb8ff", "#e0f1ff"]],
];
function textTexture(kicker, title, line) {
  const c = document.createElement("canvas"); c.width = 1024; c.height = 640;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `34px ${font}`; g.globalAlpha = 0.8; g.fillText(kicker.toUpperCase(), 512, 190);
  g.globalAlpha = 1;
  let size = 128; g.font = `${size}px ${font}`;
  while (g.measureText(title.toUpperCase()).width > 900) { size -= 4; g.font = `${size}px ${font}`; }
  g.fillText(title.toUpperCase(), 512, 300);
  g.font = `36px ${font}`; g.globalAlpha = 0.85;
  const words = line.split(" "); let l = "", y = 420; const lines = [];
  for (const w of words) { if (g.measureText(l + w).width > 760) { lines.push(l.trim()); l = ""; } l += w + " "; }
  lines.push(l.trim()); lines.forEach((t, i) => g.fillText(t, 512, y + i * 48));
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4; return tex;
}
const cardGeo = new RoundedBoxGeometry(2.3, 1.43, 0.07, 6, 0.09);
const contentGeo = new THREE.PlaneGeometry(2.21, 1.34);
const cards = [];
const cardYs = [];
for (let i = 0; i < CARDS.length; i++) cardYs.push(lerp(SPINE.top - 1.3, SPINE_BOTTOM + 1.6, i / (CARDS.length - 1)));
CARDS.forEach(([kicker, title, line, cols], i) => {
  const y = cardYs[i], side = 1;
  const a = SPIN(y) + 0.42, r = mobile ? 2.4 : 3.9;
  const group = new THREE.Group();
  group.position.set(Math.sin(a) * r, y, Math.cos(a) * r);
  group.lookAt(Math.sin(a) * 20, y + 0.6, Math.cos(a) * 20);
  group.rotateY(-0.22);
  const u = { uTime: { value: 0 }, uGlitch: { value: 1 }, uSeed: { value: i * 7.3 }, uText: { value: null },
    uC1: { value: new THREE.Color(cols[0]) }, uC2: { value: new THREE.Color(cols[1]) }, uC3: { value: new THREE.Color(cols[2]) } };
  const content = new THREE.Mesh(contentGeo, new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: NOISE + `
      uniform float uTime, uGlitch, uSeed; uniform sampler2D uText; uniform vec3 uC1,uC2,uC3; varying vec2 vUv;
      void main(){
        vec2 q=vUv*vec2(1.7,1.)*1.6;
        float w=fbm(vec3(q*1.2, uTime*.05+uSeed));
        float f=fbm(vec3(q+w*1.4, uTime*.035+uSeed*2.));
        vec3 col=mix(uC1*.35, uC2*.75, smoothstep(-.35,.55,f));
        col=mix(col, uC3*.9, smoothstep(.45,.95,f)*.7);
        col*=.85-.35*length(vUv-.5);
        float row=floor(vUv.y*36.);
        float jit=step(.55, fract(sin(row*91.7+floor(uTime*24.))*43758.5))*uGlitch;
        vec2 tu=vUv+vec2(jit*.05*sin(uTime*70.+row),0.);
        float sp=.004+uGlitch*.012;
        vec3 t=vec3(texture2D(uText,tu+vec2(sp,0.)).a, texture2D(uText,tu).a, texture2D(uText,tu-vec2(sp,0.)).a);
        col=mix(col, vec3(1.), t*(1.-uGlitch*.35));
        col+=t*vec3(.25,.0,.35)*uGlitch;
        gl_FragColor=vec4(col,1.);
      }`,
  }));
  const slab = new THREE.Mesh(cardGeo, glass(cols[2]));
  slab.material.thickness = 0.25; slab.material.roughness = 0; slab.material.iridescence = 0.6;
  group.add(content, slab);
  scene.add(group);
  cards.push({ group, u, y, title, kicker, line, fired: false, glitch: 1 });
  addSite(y, i, SPIN(y) - 1.1);
});

// ---------- bokeh: dust, flower clusters, streams, roots ----------
const PAL = ["#57e0c7", "#ff5fae", "#7a5cff", "#ffb347", "#8de0a6", "#ff8fb8", "#9fd8ff", "#c77dff"].map((c) => new THREE.Color(c));
const pts = [], col = [], siz = [], seed = [], kind = [];
const add = (x, y, z, c, s, k = 0) => { pts.push(x, y, z); col.push(c.r, c.g, c.b); siz.push(s); seed.push(R()); kind.push(k); };
const N = mobile ? 0.45 : 1;
// dust everywhere
for (let i = 0; i < 5200 * N; i++) { const x = (R() - 0.5) * 60, y = lerp(-50, 18, R()), z = (R() - 0.5) * 60; if (Math.hypot(x, z) < 17) continue; add(x, y, z, PAL[(R() * PAL.length) | 0].clone().lerp(new THREE.Color('#cfe3e6'), 0.5), 0.35 + R() * 0.7); }
// flower clusters hugging the spine
for (let k = 0; k < 26; k++) {
  const y = lerp(SPINE.top + 0.5, SPINE_BOTTOM - 0.5, R()), back = SPIN(y) + Math.PI + (R() - 0.5) * 2.2, r = 1.6 + R() * 2.4;
  const c0 = PAL[(R() * PAL.length) | 0], c1 = PAL[(R() * PAL.length) | 0], rad = 0.45 + R() * 0.8;
  for (let i = 0; i < 1500 * N; i++) {
    const v = new THREE.Vector3(gauss(), gauss(), gauss()).normalize();
    const lump = 0.65 + 0.35 * Math.sin(v.x * 5 + k) * Math.cos(v.y * 4 - k) + 0.2 * Math.sin(v.z * 9);
    v.multiplyScalar(rad * lump * Math.pow(R(), 0.25));
    add(Math.sin(back) * r + v.x, y + v.y * 1.4, Math.cos(back) * r + v.z, c0.clone().lerp(c1, R()), 0.5 + R() * 1.3, 1);
  }
}
// digital roots below the spine: branching, glowing, carrying value away
const rootTips = [];
{
  // a real root system: a taproot and a crown of main roots that wander, taper and fork into hundreds of fine rootlets.
  // Each fee line grows its own wedge of the fan (4, 4, 3, 1 main roots), so the colours never mix.
  const segs = [], up = new THREE.Vector3(0, 1, 0);
  const grow = (p, dir, len, r, depth, line, d0, gravity) => {
    const steps = Math.max(3, Math.round(len / 0.16)), stepL = len / steps, d = dir.clone();
    let pos = p.clone(), dist = d0;
    for (let s = 0; s < steps; s++) {
      d.x += (R() - 0.5) * 0.17; d.z += (R() - 0.5) * 0.17; d.y += (R() - 0.5) * 0.1 - gravity; d.normalize();
      const nxt = pos.clone().addScaledVector(d, stepL), t = (s + 1) / steps, rr = r * (1 - t * 0.6);
      segs.push({ a: pos, b: nxt, r: rr, line, d0: dist, d1: dist + stepL, depth });
      if (depth < 5 && rr > 0.013 && R() < [0.38, 0.3, 0.22, 0.15, 0.1][depth]) {  // laterals all along the root, not just at its end
        const side = new THREE.Vector3().crossVectors(d, up).normalize().multiplyScalar(R() < 0.5 ? -1 : 1).applyAxisAngle(d, (R() - 0.5) * 1.6);
        const nd = d.clone().multiplyScalar(0.45).add(side).normalize();
        grow(nxt, nd, len * (0.32 + R() * 0.28) * (1 - t * 0.35), rr * (0.42 + R() * 0.18), depth + 1, line, dist + stepL, gravity * 0.8 + 0.01);
      }
      pos = nxt; dist += stepL;
    }
    if (depth < 4) for (let k = 0; k < 2; k++) {   // the tip forks
      const nd = d.clone().add(new THREE.Vector3((R() - 0.5) * 0.9, -0.1 - R() * 0.2, (R() - 0.5) * 0.9)).normalize();
      grow(pos, nd, len * (0.35 + R() * 0.2), r * 0.4 * (0.7 + R() * 0.3), depth + 1, line, dist, gravity);
    }
  };
  const base = new THREE.Vector3(0, ROOT_Y + 0.3, 0);
  // the crown: main roots fanning out and down, each in its own fee line's slice
  const MAIN = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3];
  for (let k = 0; k < MAIN.length; k++) {
    const az = -2.75 + (k / (MAIN.length - 1)) * 2.65 + (R() - 0.5) * 0.08, line = MAIN[k];  // fanned left to right, wedge by wedge
    const p = base.clone().add(new THREE.Vector3(0, -R() * 0.35, 0));
    const len = 3.1 + R() * 0.6;
    grow(p, new THREE.Vector3(Math.cos(az), -0.5 - R() * 0.2, Math.sin(az) * 0.5).normalize(), len, 0.11 + R() * 0.03, 1, line, 0, 0.025);
    if (rootTips[line] == null) rootTips[line] = p.clone().add(new THREE.Vector3(Math.cos(az) * len * 0.55, -len * 0.3, Math.sin(az) * len * 0.55));
  }
  const maxD = Math.max(...segs.map((g) => g.d1));
  const rootCols = ["#ff6f5e", "#4fd6c8", "#ffc06b", "#b98bff"].map((c) => new THREE.Color(c)), bone = new THREE.Color("#f3e6ff");
  segs.forEach((g) => {
    const L = g.b.distanceTo(g.a), n = Math.ceil(L * (22 + 2600 * g.r) * N);
    const c = g.line < 0 ? bone : rootCols[g.line];
    for (let i = 0; i < n; i++) {
      const f = R(), p = g.a.clone().lerp(g.b, f), th = g.r * 0.75;
      add(p.x + gauss() * th, p.y + gauss() * th, p.z + gauss() * th, c.clone().lerp(bone, R() * 0.12), 0.6 + R() * (0.5 + g.r * 14), 3);
      seed[seed.length - 1] = (g.d0 + (g.d1 - g.d0) * f) / maxD; // root particles: seed carries the path position for the flow pulses
    }
  });
}
const rootSample = [];
for (let j = 0; j < kind.length; j += 3) if (kind[j] === 3) rootSample.push(new THREE.Vector3(pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2]));
const bGeo = new THREE.BufferGeometry();
bGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
bGeo.setAttribute("aColor", new THREE.Float32BufferAttribute(col, 3));
bGeo.setAttribute("aSize", new THREE.Float32BufferAttribute(siz, 1));
bGeo.setAttribute("aSeed", new THREE.Float32BufferAttribute(seed, 1));
bGeo.setAttribute("aKind", new THREE.Float32BufferAttribute(kind, 1));
const bU = { uTime: { value: 0 }, uFocus: { value: 7 }, uPR: { value: DPR }, uRoots: { value: 0 }, ...maskU };
const bokeh = new THREE.Points(bGeo, new THREE.ShaderMaterial({
  uniforms: bU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `
    uniform float uTime, uFocus, uPR, uRoots; attribute vec3 aColor; attribute float aSize, aSeed, aKind;
    uniform vec4 uMask[6]; uniform float uMaskN; uniform vec2 uRes;
    // text never sits on particles: background motes inside a visible text box (padded by the mote's own size) vanish
    float textMask(vec4 clip, float sizePx){
      vec2 uv = clip.xy/clip.w*.5 + .5; uv.y = 1. - uv.y;
      vec2 pad = vec2(sizePx*.5 + 12.)/uRes;
      float k = 1.;
      for (int i = 0; i < 6; i++) {
        if (float(i) >= uMaskN) break;
        vec4 r = uMask[i];
        vec2 lo = r.xy - pad, hi = r.zw + pad;
        k *= 1. - step(lo.x, uv.x)*step(uv.x, hi.x)*step(lo.y, uv.y)*step(uv.y, hi.y);
      }
      return k;
    }
    varying vec3 vC; varying float vA, vCoc;
    void main(){
      vec3 p=position;
      float s=aKind>2.5?fract(aSeed*13.7):aSeed;
      p+=vec3(sin(uTime*.3+s*40.),cos(uTime*.25+s*30.),sin(uTime*.2+s*20.))*(aKind>2.5?.015:.06);
      if(aKind>1.5&&aKind<2.5) p.x+=mod(uTime*.25*(.5+s),34.)-17.;
      vec4 mv=modelViewMatrix*vec4(p,1.);
      float d=-mv.z;
      float coc=clamp(abs(d-uFocus)*.35,0.,aKind>1.5&&aKind<2.5?1.5:6.);
      gl_PointSize=(aSize*1.4+coc*4.5)*uPR*(9./d);
      gl_Position=projectionMatrix*mv;
      vCoc=coc;
      vA=(.6/(1.+coc*coc*.6))*smoothstep(.3,1.2,d);
      vC=aColor;
      if(aKind>2.5){ float pulse=pow(1.-fract(aSeed*3.-uTime*.35),8.); vC=mix(aColor,vec3(1.),pulse*.6); vA*=(.36+pulse*.5)*uRoots; }
      vA*=textMask(gl_Position, gl_PointSize);
    }`,
  fragmentShader: `
    varying vec3 vC; varying float vA, vCoc;
    void main(){
      float d=length(gl_PointCoord-.5)*2.;
      if(d>1.) discard;
      float disc=smoothstep(1.,.82,d);
      float rim=smoothstep(.55,.95,d)*min(vCoc*.25,.6);
      gl_FragColor=vec4(vC*(disc+rim), disc*vA);
    }`,
}));
bokeh.frustumCulled = false;
scene.add(bokeh);

// ---------- utility organs: translucent-petal particle systems that grow off the helix ----------
// One shared petal shader; each organ type injects its own animation, driven by uP (0 → 1 as the camera arrives and holds).
const ORG_MASK = `
    uniform vec4 uMask[6]; uniform float uMaskN; uniform vec2 uRes;
    float textMask(vec4 clip, float sizePx){
      vec2 uv = clip.xy/clip.w*.5 + .5; uv.y = 1. - uv.y;
      vec2 pad = vec2(sizePx*.5 + 12.)/uRes;
      float k = 1.;
      for (int i = 0; i < 6; i++) {
        if (float(i) >= uMaskN) break;
        vec4 r = uMask[i];
        vec2 lo = r.xy - pad, hi = r.zw + pad;
        k *= 1. - step(lo.x, uv.x)*step(uv.x, hi.x)*step(lo.y, uv.y)*step(uv.y, hi.y);
      }
      return k;
    }`;
const CHUNKS = {
  vote: `
    float grow = smoothstep(0., .25, uP), decide = smoothstep(.62, .84, uP), graft = smoothstep(.86, .99, uP);
    if (aPart < 2.5) {
      vec3 c = aPart < .5 ? uV0 : (aPart < 1.5 ? uV1 : uV2);
      float win = step(.5, aPart)*step(aPart, 1.5);
      vec3 rel = p - c;
      p = c + rel*grow*(1. + win*decide*.55);
      if (win < .5) { p.y -= decide*decide*(1.6 + aRnd*1.8); p += aDir*decide*.3; a *= 1. - decide*.9; col = mix(col, vec3(.3, .28, .36), decide*.8); }
      else { p = mix(p, uAxis + rel*.25, graft); a *= 1. - graft*.5; col *= 1. + decide*.3; }
    } else if (aPart < 3.5) {
      float k = floor(aRnd*3.);
      vec3 c = k < .5 ? uV0 : (k < 1.5 ? uV1 : uV2);
      float t = fract(aRnd*13.7 + uTime*.09);
      p = mix(aBase, c, t*t) + aDir*sin(t*3.1416)*.5;
      a *= sin(t*3.1416)*grow*(1. - smoothstep(.66, .8, uP));
      size *= .8;
    } else {
      float k = aPart - 4.;
      vec3 c = k < .5 ? uV0 : (k < 1.5 ? uV1 : uV2);
      float win = step(.5, k)*step(k, 1.5), t = aBase.x;
      vec3 mid = mix(uAxis, c, .5) + vec3(0., -.5, 0.);
      p = mix(mix(uAxis, mid, t), mix(mid, c, t), t) + vec3(0., aBase.y, aBase.z) + aDir*(.06 + .12*aRnd)*sin(t*3.1416);
      a *= step(t, grow*1.02);
      if (win < .5) { p.y -= decide*decide*t*1.4; a *= 1. - decide*.9; } else a *= 1. - graft;
    }`,
  jackpot: `
    float fill = smoothstep(0., .42, uP), fire = smoothstep(.46, .52, uP), after = smoothstep(.52, .85, uP);
    if (aPart < .5) {
      float r = mix(.45, 1., fill)*(1. + .04*sin(uTime*2. + aRnd*6.))*(1. - fire*.25 + after*.25);
      p = aBase*r; col *= .62 + fill*.28;   // a warm glow, not a blown-out sun
    } else if (aPart < 1.5) {
      float t = fract(aBase.x + uTime*.22);
      vec3 src = uAxis + vec3(0., (aBase.y - 1.5)*.7, 0.);
      vec3 mid = mix(src, vec3(0.), .5) + vec3(0., .7, 0.);
      p = mix(mix(src, mid, t), mix(mid, vec3(0.), t), t) + aDir*(.12 + .22*aRnd)*sin(t*3.1416);
      a *= smoothstep(0., .1, t)*smoothstep(1., .8, t)*(1. - fire)*.6;
      size *= .75;
    } else if (aPart < 2.5) {
      float t = aBase.x;
      p = mix(vec3(0.), uWin, t) + aDir*(.04 + .1*aRnd)*(1. - t);
      a *= fire*(1. - smoothstep(.8, .92, uP))*step(t, smoothstep(.46, .54, uP)*1.05);
      col = mix(col, vec3(1., .95, .85), .5);
    } else if (aPart < 3.5) {
      p = uWin + aBase*(.2 + after*.35);
      a *= smoothstep(.5, .56, uP); col *= 1.4;
    } else {
      float ang = aBase.x + uTime*.2*(.5 + aRnd), rr = 1.3 + aBase.y*.6;
      p = vec3(cos(ang)*rr, aBase.z, sin(ang)*rr*.45);
      a *= fill*.7;
    }`,
  streak: `
    float k = aPart, appear = smoothstep(k*.085, k*.085 + .07, uP);
    float ang = aBase.x + uTime*(.06 + k*.012)*(mod(k, 2.) < .5 ? 1. : -1.);
    float reset = abs(k - 4.) < .5 ? smoothstep(.66, .74, uP)*(1. - smoothstep(.8, .92, uP)) : 0.;
    float r = aBase.y*(1. - reset*.92);
    p = vec3(cos(ang)*r, aBase.z + sin(ang*3. + uTime*.5)*.03, sin(ang)*r);
    a *= appear*(1. - reset*.6);
    col = mix(col, vec3(1., .55, .6), reset);`,
  rewards: `
    float sh = smoothstep(.82, .95, uP);
    if (aPart < .5) {
      p = aBase*(1. + .03*sin(uTime*1.5 + aRnd*9.)) + aBase*sh*(.8 + aRnd*1.6);
      col = mix(col, vec3(1., .85, .6)*(.7 + aRnd*.6), sh);
      a *= 1. - smoothstep(.9, .98, uP);
    } else if (aPart < 1.5) {
      float f = aBase.x, ang = f*6.2832 - 1.5708;
      p = vec3(cos(ang)*2.25, sin(ang)*2.25, 0.)*(1. + sh*.3);
      float lit = step(f, uP/.82);
      col = mix(vec3(.25, .25, .3), col, lit); a *= (.35 + lit*.65)*(1. - sh);
    } else {
      float t = fract(aRnd*7.1 + uTime*.15);
      p = mix(aBase, normalize(aBase)*1.3, smoothstep(.55, 1., t));
      a *= smoothstep(0., .15, uP)*(1. - sh)*sin(t*3.1416 + .2);
      size *= .7;
    }`,
  mystery: `
    float sp2 = smoothstep(.5, .7, uP);
    if (aPart < .5) {
      float side = aBase.x < 0. ? -1. : 1., ang = -side*sp2*.7;
      p = vec3(aBase.x*cos(ang) - aBase.z*sin(ang), aBase.y, aBase.x*sin(ang) + aBase.z*cos(ang)) + vec3(side*sp2*1.3, 0., -sp2*.6);
      col *= .7 + .3*sin(uTime*.8 + aBase.y*3. + aRnd*6.);
    } else if (aPart < 1.5) {
      a *= (.6 + .4*sin(uTime*3. + aBase.y*6.))*(1. - sp2); col *= 1.6;
    } else if (aPart < 2.5) {
      float burst = smoothstep(.5, .62, uP)*(1. - smoothstep(.62, .82, uP));   // a shockwave that reaches out and comes back
      p = aBase*(.3 + sp2*.85 + burst*1.6*aRnd)*(1. + .05*sin(uTime*2.5 + aRnd*9.));
      a *= sp2*(1. - smoothstep(.88, 1., uP)*.85); col *= 1.5 + burst*.8;   // the light settles once you've seen it
    } else {
      float lit = step(aDir.x, uP*1.75);
      col = mix(vec3(.22, .22, .3), col*1.3, lit); a *= .4 + lit*.6;
    }`,
  roots: `
    if (aPart < .5) {
      float t = fract(aRnd*9.1 + uTime*.06);
      p = uT0 + aBase*.5 + vec3(sin(t*6. + aRnd*20.)*.35, t*6., cos(t*5. + aRnd*13.)*.35);
      col = mix(vec3(1., .72, .45), vec3(.9, .22, .5), t); a *= (1. - t)*smoothstep(0., .08, t); size *= .8;
    } else if (aPart < 1.5) {
      float t = fract(aBase.x + uTime*.1);
      vec3 a0 = uT1, a3 = vec3(0., uLoopY, 0.), a1 = uT1 + vec3(-2.8, 2., 1.2), a2 = a3 + vec3(-2.6, -1.6, 1.4);
      float u = 1. - t;
      p = u*u*u*a0 + 3.*u*u*t*a1 + 3.*u*t*t*a2 + t*t*t*a3 + aDir*(.12 + .3*aRnd)*sin(t*3.1416 + .3);
      a *= smoothstep(0., .05, t)*smoothstep(1., .92, t);
    } else if (aPart < 2.5) {
      p = uT2 + aBase*(.7 + uP*.7)*(1. + .05*sin(uTime*2. + aRnd*7.));
      col *= 1.15 + .3*sin(uTime*3. + aRnd*20.);
    } else if (aPart < 3.5) {
      p = vec3(aBase.x, uFloor + aBase.y*.3, aBase.z); a *= .3; size *= 1.8;
    } else if (aPart < 4.5) {
      float t = fract(aRnd*5.3 + uTime*.03);
      p = aBase + vec3(0., t*3., 0.); a *= sin(t*3.1416)*.35; size *= .6;
    } else {
      float t = fract(aBase.x + uTime*.16);
      vec3 q0 = uT3, q2 = uJack, q1 = mix(q0, q2, .5) + vec3(1.5, 0., 1.);
      p = mix(mix(q0, q1, t), mix(q1, q2, t), t) + aDir*(.25 + .55*aRnd)*sin(t*3.1416);
      a *= smoothstep(0., .06, t)*smoothstep(1., .85, t)*.55; size *= .8;
    }`,
};
function organMaterial(type, extra) {
  const u = { uTime: dnaU.uTime, uP: { value: 0 }, uViewH: dnaU.uViewH, uFocus: dnaU.uFocus, uAxis: { value: new THREE.Vector3() }, uMobile: dnaU.uMobile, ...maskU, ...extra };
  const decl = Object.keys(extra).map((k) => `uniform ${extra[k].value.isVector3 ? "vec3" : "float"} ${k};`).join(" ");
  return new THREE.ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false,
    vertexShader: `
      uniform float uTime, uP, uViewH, uFocus, uMobile; uniform vec3 uAxis; ${decl}
      attribute vec3 aBase, aDir, aCol; attribute float aRnd, aSize, aPart;
      varying vec3 vC; varying float vA, vCoc; ${ORG_MASK}
      // key light from the upper right (in view space, so every shot is lit the same way), a rim on the silhouette, haze with depth
      float keyLight(vec3 n, float d){
        vec3 nV = normalize((modelViewMatrix*vec4(n, 0.)).xyz);
        float key = max(dot(nV, normalize(vec3(.55, .55, .62))), 0.), rim = pow(1. - abs(nV.z), 3.);
        return (.56 + .72*key + .36*rim)*(1. - .42*smoothstep(uFocus + 2., uFocus + 16., d));
      }
      void main(){
        vec3 p = aBase, col = aCol; float a = 1., size = aSize;
        ${CHUNKS[type]}
        p += aDir*(.05 + .06*aRnd)*sin(uTime*(.5 + aRnd*.6) + aRnd*30.);
        vec4 mv = modelViewMatrix*vec4(p, 1.); float d = -mv.z;
        vCoc = clamp(abs(d - uFocus)*.03, 0., .16);
        gl_PointSize = (size + vCoc)*uViewH/max(d, .1);
        gl_Position = projectionMatrix*mv;
        vA = a*(.55 + .35*aRnd)/(1. + vCoc*vCoc*120.);
        vA *= textMask(gl_Position, gl_PointSize);
        vC = col*keyLight(p + 1e-4, d);
      }`,
    fragmentShader: `
      varying vec3 vC; varying float vA, vCoc;
      void main(){
        float d = length(gl_PointCoord - .5)*2.; if (d > 1.) discard;
        float edge = smoothstep(.72, .97, d);
        gl_FragColor = vec4(vC*(1. - edge*.32), vA*(1. - smoothstep(.93, 1., d))*(.85 + edge*.25));
      }`,
  });
}
function particleSet() {
  const L = { base: [], dir: [], col: [], rnd: [], size: [], part: [] };
  const add = (b, part, colour, size, d = dir3()) => { L.base.push(b.x, b.y, b.z); L.dir.push(d.x, d.y, d.z); const c = new THREE.Color(colour).offsetHSL((R() - 0.5) * 0.04, 0, (R() - 0.5) * 0.12); L.col.push(c.r, c.g, c.b); L.rnd.push(R()); L.size.push(size); L.part.push(part); };
  const geo = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(L.base, 3));
    g.setAttribute("aBase", new THREE.Float32BufferAttribute(L.base, 3));
    g.setAttribute("aDir", new THREE.Float32BufferAttribute(L.dir, 3));
    g.setAttribute("aCol", new THREE.Float32BufferAttribute(L.col, 3));
    g.setAttribute("aRnd", new THREE.Float32BufferAttribute(L.rnd, 1));
    g.setAttribute("aSize", new THREE.Float32BufferAttribute(L.size, 1));
    g.setAttribute("aPart", new THREE.Float32BufferAttribute(L.part, 1));
    return g;
  };
  return { add, geo, count: () => L.rnd.length };
}
const OQ = mobile ? 0.5 : 1;
const sphereish = (r, pow = 0.4) => dir3().multiplyScalar(r * Math.pow(R(), pow));
const clump = (centre, n, r, add, part, cols, sz) => {
  const heads = Array.from({ length: 6 }, () => ({ c: dir3().multiplyScalar(r * 0.55), r: r * (0.35 + R() * 0.3) }));
  for (let i = 0; i < n * 1.3; i++) { const h = heads[(R() * heads.length) | 0]; add(centre.clone().add(h.c).add(sphereish(h.r * (R() < 0.15 ? 1.9 : 1.15), 0.7)), part, pick(cols), 0.022 + Math.pow(R(), 2.6) * 0.05); }
};
const organs = ORGANS.map((o) => {
  const P = particleSet(), extra = {};
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  if (o.type === "vote") {
    const buds = [V(-1.0, 1.15, 0.2), V(0.25, -0.15, 0.45), V(1.15, 1.0, -0.3)];
    const cols = [[PET.teal, "#86eadf", PET.ice], [PET.rose, PET.magenta, PET.coral], [PET.violet, PET.lilac, PET.deep]];
    buds.forEach((b, k) => clump(b, 2200 * OQ, 0.62, P.add, k, cols[k]));
    for (let i = 0; i < 2600 * OQ; i++) { const k = (R() * 3) | 0; P.add(dir3().multiplyScalar(2.2 + R() * 1.1).multiply(V(1, 1, 0.45)).add(V(0, 0.4, 0)), 3, pick([PET.lilac, PET.ice, PET.rose]), 0.022 + R() * 0.03); }
    for (let k = 0; k < 3; k++) for (let i = 0; i < 360 * OQ; i++) P.add(V(R(), gauss() * 0.03, gauss() * 0.03), 4 + k, pick(cols[k]), 0.024 + R() * 0.02);
    Object.assign(extra, { uV0: { value: buds[0] }, uV1: { value: buds[1] }, uV2: { value: buds[2] } });
  } else if (o.type === "jackpot") {
    for (let i = 0; i < 3200 * OQ; i++) { const v = dir3(); P.add(v.multiplyScalar(0.55 + Math.pow(R(), 0.25) * 0.45), 0, pick(["#ffc06b", "#ffd9a0", PET.coral, PET.rose, "#fff1d6"]), 0.03 + Math.pow(R(), 2) * 0.06); }
    for (let i = 0; i < 1100 * OQ; i++) P.add(V(R(), (R() * 4) | 0, 0), 1, pick(["#ffc06b", PET.rose, "#fff1d6"]), 0.022 + R() * 0.02);
    for (let i = 0; i < 700 * OQ; i++) P.add(V(R(), 0, 0), 2, pick(["#fff1d6", "#ffc06b"]), 0.03 + R() * 0.03);
    for (let i = 0; i < 380 * OQ; i++) P.add(sphereish(1, 0.5), 3, pick(["#fff1d6", "#ffc06b", PET.rose]), 0.03 + R() * 0.05);
    for (let i = 0; i < 600 * OQ; i++) P.add(V(R() * 6.2832, R(), gauss() * 0.4), 4, pick(["#ffd9a0", PET.lilac]), 0.02 + R() * 0.025);
    extra.uWin = { value: V(-0.6, 2.5, 1.1) };
  } else if (o.type === "streak") {
    for (let k = 0; k < 7; k++) {
      const r = 1.05 + k * 0.24;
      for (let i = 0; i < (700 + k * 120) * OQ; i++) P.add(V(R() * 6.2832, r + gauss() * 0.04, gauss() * 0.05 + (k - 3) * 0.04), k, pick([[PET.ice, PET.teal], [PET.teal, "#86eadf"], [PET.lilac, PET.ice], [PET.violet, PET.lilac], [PET.rose, PET.lilac], [PET.lilac, PET.violet], [PET.ice, PET.lilac]][k]), 0.022 + Math.pow(R(), 2) * 0.04);
    }
  } else if (o.type === "rewards") {
    for (let i = 0; i < 6500 * OQ; i++) {
      const v = dir3(), spike = Math.pow(Math.max(0, Math.sin(v.x * 7) * Math.cos(v.y * 6) * Math.sin(v.z * 8)), 3) * 1.4;
      const depth = 0.84 + Math.pow(R(), 0.4) * 0.16, tip = spike > 0.25 && depth > 0.94;
      P.add(v.multiplyScalar((1.05 + spike) * depth * 0.85), 0, tip ? pick(["#ffc06b", "#ffd9a0", "#fff1d6"]) : depth > 0.9 ? pick([PET.violet, PET.deep, PET.lilac, PET.magenta]) : pick(["#1c1036", "#2c1f6e", "#3a1b5e"]), 0.022 + Math.pow(R(), 2.4) * 0.045);
    }
    for (let i = 0; i < 1400 * OQ; i++) P.add(V(R(), 0, 0), 1, pick([PET.teal, "#86eadf", PET.ice]), 0.03 + R() * 0.025);
    for (let i = 0; i < 2400 * OQ; i++) P.add(dir3().multiplyScalar(2.3 + R() * 1.1).multiply(V(1, 1, 0.45)), 2, pick([PET.ice, PET.teal, PET.lilac, "#fff1d6"]), 0.02 + R() * 0.025);
  } else if (o.type === "mystery") {
    const pod = (u) => 1.05 * Math.pow(Math.max(0, 1 - u * u), 0.55) * (1 + 0.14 * u); // chrysalis profile: full shoulders, pointed ends
    for (let i = 0; i < 5200 * OQ; i++) {
      const u = R() * 2 - 1, a = R() * Math.PI * 2, shell = R() < 0.78, r = pod(u) * (shell ? 0.95 + R() * 0.06 : Math.pow(R(), 0.5) * 0.85);
      P.add(V(Math.cos(a) * r, u * 1.7, Math.sin(a) * r), 0, shell ? pick(["#fff1d6", "#ffd9a0", "#e8d2ff", PET.ice, "#ffc06b", "#f4e6ff"]) : pick(["#1c1036", "#2c1f6e", "#3a1b5e"]), shell ? 0.02 + Math.pow(R(), 2.4) * 0.04 : 0.03 + R() * 0.04);
    }
    for (let i = 0; i < 700 * OQ; i++) { const u = R() * 2 - 1, r = pod(u) * 1.02; P.add(V(0, u * 1.7, (R() < 0.5 ? -1 : 1) * r), 1, pick(["#fff1d6", "#ffc06b", "#ffffff"]), 0.025 + R() * 0.02); }
    for (let i = 0; i < 2000 * OQ; i++) P.add(sphereish(1, 0.5), 2, pick(["#fff1d6", "#ffd9a0", "#ffc06b", "#ffffff"]), 0.03 + R() * 0.05);
    for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2 + Math.PI / 2; for (let i = 0; i < 70 * OQ; i++) P.add(V(Math.cos(a) * 2.35, Math.sin(a) * 2.35, 0).add(sphereish(0.05)), 3, pick([PET.ice, "#ffd9a0"]), 0.022 + R() * 0.015, V(k / 12, 0, 0)); }
  }
  const pts = new THREE.Points(P.geo(), organMaterial(o.type, extra));
  pts.frustumCulled = false;
  pts.position.copy(o.centre);
  if (o.type !== "streak") pts.lookAt(o.cam.x, o.centre.y, o.cam.z); // its face (local XY) towards the camera stop
  scene.add(pts);
  pts.updateMatrixWorld();
  pts.material.uniforms.uAxis.value.copy(pts.worldToLocal(new THREE.Vector3(0, o.centre.y, 0)));
  return { ...o, pts, extent: { vote: 2.2, jackpot: 2.0, streak: 2.6, rewards: 2.6, mystery: 2.5 }[o.type] };
});

// the roots, made dramatic: embers rise off the burn, liquidity loops back up into the helix,
// the treasury grows a crystal seed, the games root feeds a stream back up to the jackpot, mist glows underneath
const rootsFx = (() => {
  const P = particleSet();
  for (let i = 0; i < 2600 * OQ; i++) P.add(sphereish(1, 0.6), 0, "#ff9b6a", 0.025 + R() * 0.04);
  for (let i = 0; i < 2200 * OQ; i++) P.add(new THREE.Vector3(R(), 0, 0), 1, pick([PET.teal, "#86eadf", PET.ice]), 0.025 + R() * 0.03);
  for (let i = 0; i < 2000 * OQ; i++) P.add(sphereish(0.26, 0.35), 2, pick(["#ffc06b", "#ffd9a0", "#fff1d6", PET.coral]), 0.03 + Math.pow(R(), 2) * 0.06);
  for (let i = 0; i < 2200 * OQ; i++) { const a = R() * Math.PI * 2, r = Math.sqrt(R()) * 5.5; P.add(new THREE.Vector3(Math.cos(a) * r, R(), Math.sin(a) * r), 3, pick(["#0f3a2f", "#16304a", "#2a1240", PET.teal]), 0.05 + R() * 0.08); }
  for (let i = 0; i < 1600 * OQ; i++) { const a = R() * Math.PI * 2, r = 1 + R() * 5; P.add(new THREE.Vector3(Math.cos(a) * r, ROOT_Y - 4 + R() * 4, Math.sin(a) * r), 4, pick([PET.ice, PET.lilac, "#86eadf"]), 0.02 + R() * 0.03); }
  for (let i = 0; i < 900 * OQ; i++) P.add(new THREE.Vector3(R(), 0, 0), 5, pick([PET.lilac, "#ffc06b", PET.violet]), 0.024 + R() * 0.025);
  const V3 = (v) => ({ value: v.clone() });
  const jack = organs.find((o) => o.type === "jackpot");
  const m = organMaterial("roots", { uT0: V3(rootTips[0]), uT1: V3(rootTips[1]), uT2: V3(rootTips[2]), uT3: V3(rootTips[3]), uJack: V3(jack.centre), uLoopY: { value: ROOT_Y + 6 }, uFloor: { value: ROOT_Y - 6.4 } });
  const pts = new THREE.Points(P.geo(), m);
  pts.frustumCulled = false; scene.add(pts);
  return pts;
})();

// ---------- light shafts: long soft beams behind the helix, always on the far side from the camera ----------
const beams = [["#5fd6c8", -0.9, 0.14, 1.6, 0.22], ["#8a5cf0", 0.35, -0.1, 2.4, 0.18], ["#d24aa8", 1.2, 0.18, 1.2, 0.14], ["#cdb6ff", -0.25, -0.22, 0.8, 0.2], ["#ff86bb", 0.8, 0.05, 1.9, 0.1], ["#4f7bff", -1.4, -0.08, 2.8, 0.12]]
  .map(([c, off, tilt, wdt, a], k) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uC: { value: new THREE.Color(c) }, uA: { value: a }, uTime: dnaU.uTime, uSeed: { value: k * 1.7 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `uniform vec3 uC; uniform float uA, uTime, uSeed; varying vec2 vUv;
        void main(){ float x=(vUv.x-.5)*2.; float a=exp(-x*x*3.5)*smoothstep(0.,.35,vUv.y)*smoothstep(1.,.55,vUv.y)*uA*(.75+.25*sin(uTime*.35+uSeed));
          gl_FragColor=vec4(uC*a, a); }`,
    }));
    m.scale.set(wdt, 34, 1); m.renderOrder = -0.5; scene.add(m);
    return { m, off, tilt };
  });
function updateBeams() {
  const back = Math.atan2(-camPos.x, -camPos.z);
  beams.forEach((b) => {
    const a = back + b.off * 0.55;
    b.m.position.set(Math.sin(a) * 7.5, camLook.y + 4, Math.cos(a) * 7.5);
    b.m.lookAt(camPos.x, b.m.position.y, camPos.z);
    b.m.rotateZ(b.tilt);
  });
}

// ---------- background: void with section-coloured corners ----------
const bgU = { uTime: { value: 0 }, uRes: { value: new THREE.Vector2() }, uA: { value: new THREE.Color("#0e3a3c") }, uB: { value: new THREE.Color("#1a1030") } };
const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: bgU, depthTest: false, depthWrite: false,
  vertexShader: `void main(){ gl_Position=vec4(position.xy,.9999,1.); }`,
  fragmentShader: `uniform vec2 uRes; uniform vec3 uA,uB; uniform float uTime;
    void main(){ vec2 uv=gl_FragCoord.xy/uRes; vec2 p=uv-.5; p.x*=uRes.x/uRes.y;
      float asp=uRes.x/uRes.y;
      vec2 key=asp>1. ? vec2(.3*asp,.16) : vec2(0.,-.18);          // behind the subject: right on desktop, below the text on phones
      vec3 c=vec3(.006,.009,.013);
      vec2 q=p-key; c+=uA*exp(-dot(q,q)*2.4)*1.35;                   // key glow
      q=p-key-vec2(.2,-.5); c+=uB*exp(-dot(q,q)*1.8)*1.1;            // second colour pooled below it
      c+=mix(uA,uB,.5)*.12;                                          // a breath of ambient so the dark never goes dead
      c*=1.-.3*length(p);
      gl_FragColor=vec4(c,1.); }`,
}));
bg.frustumCulled = false; bg.renderOrder = -1; scene.add(bg);
// corner colours along the journey: hero teal, spine violet/magenta, roots green, home teal
const MOODS = [
  [0, "#0e3a3c", "#14202e"], [arrive(4), "#0f2f3a", "#2a1240"], [arrive(ORGANS[0].stop - 1), "#2a0f33", "#0f2a3a"],
  [arrive(ORGANS[0].stop), "#24104a", "#0d3a3a"],   // vote: violet and teal
  [arrive(ORGANS[1].stop), "#3d2208", "#3a0f2a"],   // jackpot: amber and rose
  [arrive(ORGANS[2].stop), "#0b3440", "#1a2350"],   // streak: teal and ice blue
  [arrive(ORGANS[3].stop), "#2a1240", "#3a2a0a"],   // idea rewards: violet and gold
  [arrive(ORGANS[4].stop), "#120d3a", "#0b2b33"],   // mystery: indigo
  [arrive(PATH.length - 3), "#0c3326", "#3a2a0a"],  // roots: moss and gold
  [arrive(PATH.length - 2), "#0e2a3c", "#1c1036"], [1, "#0e3a3c", "#14202e"],
].map(([p, a, b]) => [p, new THREE.Color(a), new THREE.Color(b)]);

// ---------- post ----------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.7, 0.72);
composer.addPass(bloom);
const finish = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
    void main(){ vec2 d=(vUv-.5)*.0022*length(vUv-.5)*2.;
      vec4 c=vec4(texture2D(tDiffuse,vUv+d).r, texture2D(tDiffuse,vUv).g, texture2D(tDiffuse,vUv-d).b, 1.);
      c.rgb+=(h(vUv*vec2(1731.,977.)+fract(uTime*7.))-.5)*.045;
      float l=dot(c.rgb,vec3(.299,.587,.114));
      c.rgb=mix(c.rgb*vec3(.93,.98,1.07), c.rgb*vec3(1.06,1.,.93), smoothstep(.12,.7,l));   // cool shadows, warm highlights
      c.rgb*=1.-.3*pow(length((vUv-.5)*vec2(1.,.85))*1.35,2.2);                              // soft vignette
      c.rgb*=smoothstep(0.,.11,vUv.y)*mix(1.,.08,smoothstep(.9,1.,vUv.y));
      gl_FragColor=c; }`,
});
composer.addPass(finish);
composer.addPass(new OutputPass());

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); composer.setSize(w, h); bloom.setSize(w * 0.5, h * 0.5);
  camera.aspect = w / h;
  // narrower-than-16:10 desktop windows keep the 16:10 horizontal view, so the helix never slides under the text
  if (!mobile) camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(19)) * spanAspect() / camera.aspect));
  camera.updateProjectionMatrix();
  bgU.uRes.value.set(w * DPR, h * DPR);
  maskU.uRes.value.set(w * DPR, h * DPR);
  dnaU.uViewH.value = (h * DPR) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}
on(window, "resize", resize); resize();

// ---------- text glitch-decode (the reference's reveal) ----------
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789%/#";
function decode(el) {
  if (el.dataset.busy || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.dataset.busy = 1;
  const nodes = [];
  const walk = (n) => n.childNodes.forEach((c) => (c.nodeType === 3 ? nodes.push([c, c.textContent]) : walk(c)));
  walk(el);
  const t0 = performance.now(), dur = 900;
  (function tick(now) {
    const k = Math.min(1, (now - t0) / dur);
    nodes.forEach(([n, txt]) => {
      n.textContent = [...txt].map((ch, i) => (ch === " " || i / txt.length < k ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join("");
    });
    if (k < 1 && !dead) requestAnimationFrame(tick); else delete el.dataset.busy;
  })(t0);
}

// ---------- overlays ----------
const head = root.querySelector("[data-head]"), end = root.querySelector("[data-end]");
const v3 = new THREE.Vector3();
const toScreen = (p) => { v3.copy(p).project(camera); return [(v3.x * 0.5 + 0.5) * innerWidth, (-v3.y * 0.5 + 0.5) * innerHeight, v3.z]; };
let headShown = false, endShown = false, rootsShown = false;
const organEls = [...root.querySelectorAll("[data-organ]")];
const maskEls = [...root.querySelectorAll(TEXT_BOXES)];
const maskRange = document.createRange();

// demo AI status (the real site reads the live feed)
const msgs = ["reading the market", "testing a mutation on a few trades", "mutation survived · kept", "reading the market", "mutation failed · rolled back"];
let mi = 0; const statusMsg = root.querySelector("[data-status]");
if (demo && statusMsg) timers.push(setInterval(() => { mi = (mi + 1) % msgs.length; statusMsg.textContent = msgs[mi]; }, 4200));

// ---------- QA: does any particle sit on top of text? ----------
// Projects the DNA strands (with petal thickness), active mutation scatter, bokeh and roots to the screen and reports
// every visible text box or card face they overlap. Used by the QA sweep; never runs on its own.
const qaRT = new THREE.WebGLRenderTarget(1, 1);
const qaPix = () => {
  const w = renderer.domElement.width, h = renderer.domElement.height, sx = w / innerWidth;
  qaRT.setSize(w, h);
  const hidden = [bg, ...beams.map((b) => b.m)];
  hidden.forEach((o) => (o.visible = false));
  const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
  renderer.setRenderTarget(qaRT); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(scene, camera); renderer.setRenderTarget(null);
  renderer.setClearColor(cc, ca); hidden.forEach((o) => (o.visible = true));
  const report = [];
  const visible = (el) => { let o = 1; for (let e = el; e && e !== document.body; e = e.parentElement) o *= +getComputedStyle(e).opacity; return o > 0.05; };
  root.querySelectorAll(QA_TEXT).forEach((el) => {
    if (!visible(el)) return;
    const rg = document.createRange(); rg.selectNodeContents(el);
    for (const b of rg.getClientRects()) {
      const x0 = Math.max(0, Math.floor((b.left - 4) * sx)), y0 = Math.max(0, Math.floor((innerHeight - b.bottom - 4) * sx));
      const rw = Math.min(w - x0, Math.ceil((b.width + 8) * sx)), rh = Math.min(h - y0, Math.ceil((b.height + 8) * sx));
      if (rw <= 0 || rh <= 0) continue;
      const buf = new Uint8Array(rw * rh * 4);
      renderer.readRenderTargetPixels(qaRT, x0, y0, rw, rh, buf);
      let lit = 0; for (let i = 0; i < buf.length; i += 4) if (Math.max(buf[i], buf[i + 1], buf[i + 2]) > 30) lit++;
      if (lit) report.push({ text: (el.querySelector("b") ? el.textContent : el.textContent).trim().slice(0, 24), lit });
    }
  });
  return report;
};
const qa = () => {
  const vhPx = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  const pts = [];
  const spin = dnaU.uTime.value * 0.12;
  for (let i = 0; i < NBP; i++) for (const sd of [0, 1]) {
    const unzip = sstep(NBP - 30, NBP - 1, i), top = 1 - sstep(0, 18, i), r = DNA.r * (1 + unzip) * (1 - top * 0.5);
    const a = (i / DNA.perTurn) * Math.PI * 2 + spin + sd * (DNA.groove + unzip * 0.9);
    pts.push([Math.cos(a) * r, DNA.top - i * DNA.rise + (sd ? 0.3 : -0.3) * unzip, Math.sin(a) * r, 0.34, "dna"]);
  }
  organs.forEach((o) => { if (o.pts.material.uniforms.uP.value > 0.01 || camPos.distanceTo(o.centre) < 16) pts.push([o.centre.x, o.centre.y, o.centre.z, o.extent, "organ:" + o.type]); });
  if (rootsFx.material.uniforms.uP.value > 0.01) {
    rootTips.forEach((t) => pts.push([t.x, t.y, t.z, 0.8, "rootsfx"]));
    for (let k = 0; k <= 6; k++) pts.push([rootTips[0].x, rootTips[0].y + k, rootTips[0].z, 0.7, "embers"]);
    pts.push([rootTips[2].x, rootTips[2].y, rootTips[2].z, 1.3, "crystal"]);
  }
  const pos = bGeo.attributes.position.array, kd = bGeo.attributes.aKind.array, sz = bGeo.attributes.aSize.array;
  for (let j = 0; j < kd.length; j += 2) {
    if (kd[j] > 2.5 && bU.uRoots.value < 0.2) continue;
    pts.push([pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2], -sz[j], ["dust", "flower", "stream", "root"][kd[j] | 0]]); // negative = bokeh, sized like the shader
  }
  const v = new THREE.Vector3(), scr = [];
  for (const [x, y, z, rad, kind] of pts) {
    v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    const d = -v.z; if (d < 0.2) continue;
    v.set(x, y, z).project(camera);
    if (Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) continue;
    const r = rad > 0 ? (rad * vhPx) / d : ((-rad * 1.4 + clamp(Math.abs(d - bU.uFocus.value) * 0.35, 0, 6) * 4.5) * (9 / d)) / 2;
    scr.push([(v.x * 0.5 + 0.5) * innerWidth, (-v.y * 0.5 + 0.5) * innerHeight, r, d, kind]);
  }
  const masks = Array.from({ length: maskU.uMaskN.value }, (_, k) => { const m = maskU.uMask.value[k]; return { l: m.x * innerWidth - 10, t: m.y * innerHeight - 10, r: m.z * innerWidth + 10, b: m.w * innerHeight + 10 }; });
  const masked = ([x, y, r, , kind]) => (mobile || ["dust", "flower", "stream", "root"].includes(kind)) && masks.some((m) => x + r > m.l && x - r < m.r && y + r > m.t && y - r < m.b);
  const hit = (b, pad = 4) => scr.filter((q) => !masked(q)).filter(([x, y, r]) => x + r > b.left - pad && x - r < b.right + pad && y + r > b.top - pad && y - r < b.bottom + pad);
  const report = [];
  const visible = (el) => { let o = 1; for (let e = el; e && e !== document.body; e = e.parentElement) o *= +getComputedStyle(e).opacity; return o > 0.05; };
  root.querySelectorAll(QA_TEXT).forEach((el) => {
    if (!visible(el)) return;
    // measure the glyphs, not the block: a range hugs the text lines
    const rg = document.createRange(); rg.selectNodeContents(el);
    for (const b of rg.getClientRects()) { const h = hit(b); if (h.length) report.push({ text: el.className || el.tagName, kinds: [...new Set(h.map((q) => q[4]))].join("+"), n: h.length }); }
  });
  cards.forEach((c) => {
    const corners = [[-1.1, -0.67], [1.1, -0.67], [-1.1, 0.67], [1.1, 0.67]].map(([x, y]) => { const w = new THREE.Vector3(x, y, 0.05).applyMatrix4(c.group.matrixWorld); const dd = w.clone().applyMatrix4(camera.matrixWorldInverse); w.project(camera); return [(w.x * 0.5 + 0.5) * innerWidth, (-w.y * 0.5 + 0.5) * innerHeight, -dd.z, w.z]; });
    if (corners.some((q) => q[3] > 1 || q[2] < 0.2)) return;
    const nrm = new THREE.Vector3(0, 0, 1).transformDirection(c.group.matrixWorld), toCam = camPos.clone().sub(c.group.getWorldPosition(new THREE.Vector3()));
    if (nrm.dot(toCam) <= 0 || c.group.scale.x < 0.05) return;
    const b = { left: Math.min(...corners.map((q) => q[0])), right: Math.max(...corners.map((q) => q[0])), top: Math.min(...corners.map((q) => q[1])), bottom: Math.max(...corners.map((q) => q[1])) };
    if (b.right < 0 || b.left > innerWidth || b.bottom < 0 || b.top > innerHeight) return;
    const nearest = Math.min(...corners.map((q) => q[2]));
    const h = hit(b, 0).filter((q) => q[3] < nearest - 0.05);
    if (h.length) report.push({ card: c.title, kinds: [...new Set(h.map((q) => q[4]))].join("+"), n: h.length });
  });
  return report;
};

// ---------- loop ----------
const clock = new THREE.Clock();
let sp = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), tmp = new THREE.Vector3();
// capture mode: a recorder drives exact frames (fixed time step, exact scroll progress) instead of rAF
let capturing = false;
if (debug) Object.assign(window, { __frame: (p, t) => { capturing = true; tick(1 / 30, t, p); } });
function frame() {
  if (capturing || dead) return;
  tick(Math.min(clock.getDelta(), 0.05), clock.elapsedTime);
  raf = requestAnimationFrame(frame);
}
function tick(dt, t, pFixed) {
  const max = document.documentElement.scrollHeight - innerHeight;
  sp = pFixed ?? damp(sp, max > 0 ? clamp(scrollY / max, 0, 1) : 0, 4.5, dt);
  if (!Number.isFinite(sp)) sp = 0;
  const u = clamp(pathU(sp), 0, 1);
  camCurve.getPoint(u, tmp); camPos.copy(tmp);
  lookCurve.getPoint(u, tmp); camLook.copy(tmp);
  camera.position.copy(camPos);
  camera.lookAt(camLook);

  // focus on what we look at, so everything else falls into bokeh
  bU.uFocus.value = camPos.distanceTo(camLook);
  dnaU.uFocus.value = bU.uFocus.value;
  bU.uTime.value = t;
  const pRoots0 = arrive(PATH.length - 4), pRoots1 = arrive(PATH.length - 2);
  bU.uRoots.value = sstep(pRoots0 - 0.06, pRoots0, sp) * (1 - sstep(pRoots1 + 0.02, pRoots1 + 0.08, sp)) * 0.85 + 0.15;

  // the helix turns; its genes mutate as the camera passes them
  updateDNA(t, camPos.y - 0.7);
  // cards: content animates; title glitches in as the camera arrives
  cards.forEach((c) => {
    c.u.uTime.value = t;
    const near = Math.abs(camPos.y - 0.7 - c.y) < 0.9;
    if (near && !c.fired) { c.fired = true; c.glitch = 1; }
    if (!near && Math.abs(camPos.y - c.y) > 2.5) c.fired = false;
    c.glitch = damp(c.glitch, 0.04, 2.2, dt);
    c.u.uGlitch.value = c.glitch;
  });

  // utility organs: each plays as the camera arrives and holds; its title shows only during the hold
  organs.forEach((o, i) => {
    const a = arrive(o.stop), wPrev = W[o.stop - 1] / Wsum, wNext = W[o.stop] / Wsum;
    o.pts.material.uniforms.uP.value = sstep(a - wPrev * 0.35, a + wNext * 0.55, sp);
    const on = holdOn(o.stop, 0.12, 0.55, 0.75);
    organEls[i].style.opacity = on.toFixed(3);
    if (on > 0.5 && !o.shown) { o.shown = true; organEls[i].querySelectorAll("[data-glitch]").forEach(decode); }
    if (on < 0.05) o.shown = false;
  });
  {
    const ra = arrive(PATH.length - 3);
    rootsFx.material.uniforms.uP.value = sstep(ra - 0.05, ra + 0.02, sp);
    const on = holdOn(PATH.length - 3, 0.1, 0.4, 0.6);
    organEls[5].style.opacity = on.toFixed(3);
    if (on > 0.5 && !rootsShown) { rootsShown = true; organEls[5].querySelectorAll("[data-glitch]").forEach(decode); }
    if (on < 0.05) rootsShown = false;
  }

  // section mood
  let a = MOODS[0], b = MOODS[MOODS.length - 1];
  for (let k = 0; k < MOODS.length - 1; k++) if (sp >= MOODS[k][0] && sp <= MOODS[k + 1][0]) { a = MOODS[k]; b = MOODS[k + 1]; }
  const mt = sstep(a[0], b[0], sp);
  bgU.uA.value.copy(a[1]).lerp(b[1], mt); bgU.uB.value.copy(a[2]).lerp(b[2], mt); bgU.uTime.value = t;
  finish.uniforms.uTime.value = t;

  // headline: only while the camera holds close beside the organism
  const hOn = holdOn(2, 0.06, 0.18, 0.32);
  head.style.opacity = hOn.toFixed(3);
  if (hOn > 0.5 && !headShown) { headShown = true; head.querySelectorAll("[data-glitch]").forEach(decode); }
  if (hOn < 0.05) headShown = false;

  // cards fold away as the camera pulls back from the roots, so nothing small and unreadable floats in the wide shot
  const fold = sstep(arrive(PATH.length - 3) - 0.03, arrive(PATH.length - 3) + 0.005, sp); // folded before the pull-back starts
  // phones: the organ shots are wide enough to catch the last cards behind the text, so they fold as the camera leaves the spine
  const foldM = mobile ? sstep(arrive(ORGANS[0].stop - 1), arrive(ORGANS[0].stop) - 0.01, sp) : 0;
  cards.forEach((c) => c.group.scale.setScalar(Math.max(0.001, 1 - Math.max(fold, foldM))));

  // the end: home again, with the way out
  const eOn = sstep(arrive(PATH.length - 1) - (W[PATH.length - 2] / Wsum) * 0.25, arrive(PATH.length - 1) - (W[PATH.length - 2] / Wsum) * 0.03, sp);
  end.style.opacity = eOn.toFixed(3);
  end.querySelectorAll("a").forEach((a) => (a.style.pointerEvents = eOn > 0.5 ? "auto" : "none"));
  if (eOn > 0.5 && !endShown) { endShown = true; end.querySelectorAll("[data-glitch]").forEach(decode); }
  if (eOn < 0.05) endShown = false;

  // text masks for the background motes
  let mk = 0;
  for (const el of maskEls) {
    if (mk >= 6) break;
    let o = 1; for (let e = el; e && e !== document.body; e = e.parentElement) o *= +(e.style.opacity || 1);
    if (o < 0.02) continue;
    maskRange.selectNodeContents(el);
    const r = maskRange.getBoundingClientRect();
    if (r.width < 1) continue;
    maskU.uMask.value[mk++].set(r.left / innerWidth, r.top / innerHeight, r.right / innerWidth, r.bottom / innerHeight);
  }
  maskU.uMaskN.value = mk;
  updateBeams();
  composer.render();
}

history.scrollRestoration = "manual"; scrollTo(0, 0);
document.fonts.load(`128px ${font}`).catch(() => {}).then(() => { // a missing font face falls back, never blanks the page
  if (dead) return;
  cards.forEach((c) => (c.u.uText.value = textTexture(c.kicker, c.title, c.line)));
  renderer.compile(scene, camera);
  raf = requestAnimationFrame(frame);
  timers.push(setTimeout(onReady, 400));
});

if (debug) Object.assign(window, { __qaPix: qaPix, __qa: qa });
/** `reuse`: a resize rebuild keeps the WebGL context for the next scene on this canvas (a canvas whose context was
 *  force-lost can never get another one); a real unmount releases it. */
return ({ reuse = false } = {}) => {
  dead = true;
  cancelAnimationFrame(raf);
  timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
  offs.forEach((off) => off());
  history.scrollRestoration = "auto";
  if (debug) for (const k of ["__arrive", "__n", "__frame", "__qaPix", "__qa"]) delete window[k];
  scene.traverse((o) => { o.geometry?.dispose(); [].concat(o.material ?? []).forEach((m) => { Object.values(m.uniforms ?? {}).forEach((u) => u.value?.isTexture && u.value.dispose()); m.dispose(); }); });
  composer.dispose(); qaRT.dispose(); scene.environment?.dispose(); pmrem.dispose();
  renderer.dispose(); if (!reuse) renderer.forceContextLoss();
};
}
