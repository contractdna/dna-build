"use client";

import { useEffect, useRef } from "react";
import { tint, type Mood } from "./moods";

/**
 * The inner pages' live background: a DNA double helix built from particles, slowly coming apart. Raw WebGL1, no three.js.
 * Two backbone tubes and their rungs are dense particle surfaces; where a crawling erosion band passes, particles peel off
 * and filaments slide out into a slow current, and far dust motes give depth. Lit like the homepage: an amber key from
 * the upper right, a blue/lilac rim from the left. Each section shifts that light a little (moods.ts), and the light eases
 * from the last page's tint to this one's. The pointer turns the helix a little.
 *
 * Wide screens: the helix right of the copy, the left side veiled for the text. Phones: fewer, bigger, softer particles
 * and a smaller, upright helix down the right edge, partly off-screen, so the shape still reads behind the copy.
 *
 * Budget: DPR ≤ 1.5 (1 on phones), particles scaled to the canvas area, no frames while off-screen, while the tab is
 * hidden or after a lost context; prefers-reduced-motion draws one still frame; no allocation per frame. The canvas is
 * 100% of its box in CSS (never its drawing-buffer size). No WebGL: the CSS gradient on the parent stays.
 */

const VERT = `
attribute vec4 aA; // kind (0 strand, 1 rung, 2 peel, 3 filament, 4 dust), s (along the axis), r1, r2
attribute vec4 aB; // r3, r4, lag (filament: 0 head -> 1 tail), seed
uniform float uT, uPx, uAsp, uGain, uDof;
uniform vec4 uRot;   // tilt z, tilt x, pointer yaw, pointer pitch
uniform vec4 uFrame; // ndc shift x, y, zoom, point size scale
uniform vec3 uVeil;  // ndc x where the dimming ends (from, to), floor
uniform vec3 uKey, uRim, uAcc;
varying vec3 vC; varying float vA, vCoc;

const float PI = 3.14159265, TW = 1.848, TUBE = .15, RUNG = .065, D = 12., F = 4., SPIN = .09;

vec3 flow(vec3 p, float t) { // smooth, never-quite-repeating drift (incommensurate rates)
  return vec3(sin(p.y*1.7 + t*.9 + sin(p.z*1.3 - t*.5)),
              sin(p.z*1.5 - t*.7 + sin(p.x*1.9 + t*.61)),
              sin(p.x*1.2 + t*.83 + sin(p.y*1.6 - t*.43)));
}
// where the helix is coming apart: slow bands that crawl along it
float erosion(float s, float k, float t) {
  return smoothstep(.45, 1.05, sin(s*.8 + k*2.1 - t*.06)*.5 + .5 + sin(s*2.1 + t*.045 + k)*.22);
}
mat3 rx(float a) { float c = cos(a), s = sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
mat3 ry(float a) { float c = cos(a), s = sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
mat3 rz(float a) { float c = cos(a), s = sin(a); return mat3(c,s,0., -s,c,0., 0.,0.,1.); }

void main() {
  float kind = aA.x, s = aA.y, r1 = aA.z, r2 = aA.w, r3 = aB.x, r4 = aB.y, lag = aB.z, seed = aB.w;
  float k = step(.5, r1);                  // which backbone
  bool onRung = kind > .5 && kind < 1.5 || (kind > 1.5 && kind < 3.5 && r4 > .72);
  // emitted particles leave the surface as it was when they were born, so they don't swing with the turn
  float life = 7. + 9.*fract(seed*7.13), p = 0., tb = uT;
  if (kind > 1.5 && kind < 3.5) { p = fract(uT/life + seed); tb = uT - p*life; }
  float e = erosion(s, k, tb);

  // surface point + normal on a backbone tube or a rung
  float a = s*TW + tb*SPIN + k*PI;
  vec3 rad = vec3(cos(a), 0., sin(a));
  float phi = r2*6.2832 + sin(uT*.23 + seed*40.)*.25; // particles crawl a little over the surface
  float wob = sin(s*2.3 + phi*2. + uT*.37 + seed*3.)*.55 + sin(s*5.3 - phi*3. + uT*.51)*.3;
  vec3 pos, n;
  float sz;
  if (!onRung) {
    vec3 tg = normalize(vec3(-TW*sin(a), 1., TW*cos(a)));
    n = cos(phi)*rad + sin(phi)*cross(tg, rad);
    pos = rad + vec3(0., s, 0.) + n*TUBE*(1. + .22*wob + .35*e)*(.55 + .45*sqrt(r3));
    sz = .026;
  } else {
    float u = mix(.05, .95, fract(r1*7.31));
    n = cos(phi)*vec3(0., 1., 0.) + sin(phi)*vec3(-rad.z, 0., rad.x);
    pos = rad*(1. - 2.*u) + vec3(0., s, 0.) + n*RUNG*(1. + .25*wob + .15*e)*(.55 + .45*sqrt(r3));
    sz = .022;
  }
  float rungBoost = onRung && kind < 1.5 ? 1.5 : 1.;

  float alpha = 1.;
  vec3 drift = vec3(0.);
  if (kind > 1.5 && kind < 2.5) {          // peel: leaves the surface, caught by the flow, then a slow current
    pos += n*(.04 + .8*p) + flow(pos*1.3 + seed*7., tb*.12 + p*1.4)*.6*p;
    drift = vec3(.9, .32, .18)*p*p*2.4;
    alpha = smoothstep(0., .06, p)*pow(max(1. - p, 0.), 1.4)*(.2 + .8*e);
    sz = mix(.02, .008, p);
  } else if (kind > 2.5 && kind < 3.5) {   // filament: a chain sliding out along one curling path
    float q = p*1.2 - lag*.36;
    vec3 cr = cross(n, vec3(.3, 1., .2));
    vec3 tg = cr/max(length(cr), 1e-4);   // never normalize a zero vector (n can be parallel to the axis)
    vec3 bn = cross(n, tg);
    float w1 = 4. + 9.*fract(seed*3.7), w2 = 3. + 8.*fract(seed*5.9), ph = seed*20.;
    vec3 curl = tg*(sin(q*w1 + ph) - sin(ph)) + bn*(cos(q*w2 + ph*1.3) - cos(ph*1.3));
    pos += n*q*.9 + curl*.2*(.4 + q) + flow(pos*1.3 + seed*7., tb*.12 + p*1.4)*.35*q;
    drift = vec3(.9, .32, .18)*q*q*1.8;
    alpha = 1.6*step(0., q)*smoothstep(0., .05, q)*pow(max(1. - p, 0.), 1.2)*(1. - lag*.6)*(.4 + .6*e);
    sz = .013;
  } else if (kind > 3.5) {                 // dust: far and near motes for depth
    pos = vec3((r1 - .5)*16., mod(r2*14. + uT*(.04 + .06*r4), 14.) - 7., (r3 - .5)*16.);
    pos += flow(pos*.3 + seed, uT*.05)*.4;
    n = vec3(0., 0., 1.);
    sz = .03;
    alpha = .5;
  } else {
    alpha = (1. - .55*e)*rungBoost;        // the body thins where it is coming apart
  }

  mat3 R = rx(uRot.w)*ry(uRot.z)*rz(uRot.x)*rx(uRot.y);
  vec3 v = (kind > 3.5 ? pos : R*pos) + drift;
  vec3 nv = R*n;
  v.z -= D;
  float iz = 1./max(-v.z, .5);
  vec2 ndc = vec2(v.x/uAsp, v.y)*F*uFrame.z*iz + uFrame.xy;
  gl_Position = vec4(v.z < -1. ? ndc : vec2(9.), 0., 1.);

  // depth of field: focus on the axis, blur grows toward and away from the lens
  float coc = clamp(abs(-v.z - D)*uDof, 0., 2.5);
  float px = sz*F*uFrame.z*iz*uPx*uFrame.w;
  float size = px + coc*uPx*.016;
  gl_PointSize = clamp(size, 1., 80.);
  vCoc = coc;

  // light: warm key from upper right, cool rim from the left/behind; back faces dimmer (no depth test)
  float diff = max(dot(nv, normalize(vec3(.6, .55, .55))), 0.);
  float f = max(0., 1. - abs(nv.z));
  float rim = f*f*smoothstep(-.3, .7, -nv.x + .25*nv.y);
  float front = .3 + .7*smoothstep(-.7, .35, nv.z);
  float h1 = (s - (mod(uT*.22, 26.) - 13.))/.9, h2 = (s - (mod(uT*.17 + 9., 30.) - 15.))/1.3; // squares, not pow(): pow of a negative base is NaN on many GPUs
  float hot = exp(-h1*h1) + .6*exp(-h2*h2);
  vec3 col;
  if (kind < 1.5) col = (uKey*(.05 + 1.25*diff*diff) + uRim*rim*1.6 + vec3(.04))*front + uAcc*hot*.9*front;
  else if (kind < 2.5) col = mix(uKey, uAcc, step(.62, r3))*(.75 + .6*diff) + uAcc*hot*.6;
  else if (kind < 3.5) col = mix(uKey, uRim, .45)*(.55 + .7*diff) + vec3(.06);
  else col = mix(uKey, uRim, r4)*.55;

  // far side a little darker, out-of-focus spread (energy roughly kept), and the readability veil where text sits
  float fz = clamp((-v.z - D)/3., -1., 1.);
  alpha *= (1. - .35*fz)/(1. + coc*coc*2.2);
  if (px < 1.) alpha *= px;
  alpha *= mix(uVeil.z, 1., smoothstep(uVeil.x, uVeil.y, ndc.x));
  vA = alpha*uGain;
  vC = col;
}`;
const FRAG = `
precision mediump float;
varying vec3 vC; varying float vA, vCoc;
void main() {
  float d = length(gl_PointCoord - .5)*2.;
  if (d > 1.) discard;
  float b = clamp(vCoc*1.4, 0., 1.);
  float core = exp(-d*d*3.5);                                            // in focus: a soft grain, not a sphere
  float disc = (1. - smoothstep(.8, 1., d))*(.7 + .45*smoothstep(.45, .95, d)); // out of focus: a bokeh disc with a rim
  gl_FragColor = vec4(vC*vA*mix(core, disc*.75, b), 1.);
}`;

function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// the light on screen now (key, rim, accent): module-wide, so the next page's field eases from this page's tint
const cur = new Float32Array(9);
let lit = false;

/** `budget`: share of the particle count (default 1; a field that runs under a whole page's scroll asks for less) */
export function ParticleField({ mood, className, budget = 1 }: { mood: Mood; className?: string; budget?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, powerPreference: "low-power" });
    if (!gl) return;
    const coarse = matchMedia("(pointer: coarse)").matches;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const target = new Float32Array(tint(mood));
    if (!lit || still) { cur.set(target); lit = true; }

    /** program, buffer and GL state: run at mount and again after a lost context is restored (false: no shader) */
    let prog: WebGLProgram | null = null, buf: WebGLBuffer | null = null, U: Record<string, WebGLUniformLocation | null> = {};
    const init = () => {
      const sh = (type: number, src: string) => { const x = gl.createShader(type)!; gl.shaderSource(x, src); gl.compileShader(x); return x; };
      prog = gl.createProgram()!;
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
      gl.useProgram(prog);
      U = Object.fromEntries(["uT", "uPx", "uAsp", "uGain", "uDof", "uRot", "uFrame", "uVeil", "uKey", "uRim", "uAcc"].map((n) => [n, gl.getUniformLocation(prog!, n)]));
      buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      for (const [name, off] of [["aA", 0], ["aB", 4]] as const) {
        const loc = gl.getAttribLocation(prog, name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 8 * 4, off * 4);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE); // additive light, like the homepage
      gl.clearColor(5 / 255, 8 / 255, 10 / 255, 1);
      return true;
    };
    // no shader on this GPU: drop the context and hide the canvas, so the CSS gradient under it shows, not a black box
    const fail = () => { gl.getExtension("WEBGL_lose_context")?.loseContext(); canvas.hidden = true; };
    if (!init()) { fail(); return; }

    let count = 0;
    /**
     * Particles for this canvas: ~1 per 26 CSS px² (1 per 18 on phones, drawn bigger), 12k–60k (phones 8k–16k), in a
     * fixed split: 42% backbone, 28% rungs, 25% peel, 5% dust, then ~12% re-cut into 28-long filament chains. Phones keep
     * more of them on the body (52/30/14/4, 6% filaments): at that size the shape has to carry the picture.
     */
    const build = (w: number, h: number, phone: boolean) => {
      const R = rng(11), HALF = 9, STEP = 0.5, CHAIN = 28; // ~7 rungs a turn (DNA has 10): the gaps read at this size
      count = Math.round(budget * (phone ? Math.min(16000, Math.max(8000, (w * h) / 18)) : Math.min(60000, Math.max(12000, (w * h) / 26))));
      const [a0, a1, a2] = phone ? [0.52, 0.82, 0.96] : [0.42, 0.7, 0.95];
      const data = new Float32Array(count * 8);
      const chains = Math.floor((count * (phone ? 0.06 : 0.12)) / CHAIN);
      const rest = count - chains * CHAIN;
      let i = 0;
      const put = (kind: number, s: number, r1: number, r2: number, r3: number, r4: number, lag: number, seed: number) => {
        const o = i++ * 8;
        data[o] = kind; data[o + 1] = s; data[o + 2] = r1; data[o + 3] = r2; data[o + 4] = r3; data[o + 5] = r4; data[o + 6] = lag; data[o + 7] = seed;
      };
      const rungS = () => Math.round(((R() * 2 - 1) * HALF) / STEP) * STEP;
      for (let j = 0; j < rest; j++) {
        const x = R(), kind = x < a0 ? 0 : x < a1 ? 1 : x < a2 ? 2 : 4;
        const r4 = R();
        // peel sources: ~28% from rungs (r4 > .72 in the shader), they need a rung s
        const s = kind === 1 || (kind === 2 && r4 > 0.72) ? rungS() : (R() * 2 - 1) * HALF;
        put(kind, s, R(), R(), R(), r4, 0, R());
      }
      for (let c = 0; c < chains; c++) {
        const r4 = R(), s = r4 > 0.72 ? rungS() : (R() * 2 - 1) * HALF, r1 = R(), r2 = R(), r3 = R(), seed = R();
        for (let k = 0; k < CHAIN; k++) put(3, s, r1, r2, r3, r4, k / (CHAIN - 1), seed);
      }
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    };

    let raf = 0, last = 0, clock = 30, visible = true, dead = false, built = -1;
    let mx = 0, my = 0, tx = 0, ty = 0;
    const frame = (now: number) => {
      raf = 0;
      if (dead) return;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      const phone = w < 760; // the composition follows the CSS breakpoint; touch screens only get the lower DPR
      const DPR = Math.min(devicePixelRatio || 1, phone || coarse ? 1 : 1.5);
      const bw = Math.round(w * DPR), bh = Math.round(h * DPR);
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
      const key = Math.round(w / 200) * 1000 + Math.round(h / 200) + (phone ? 1e6 : 0);
      if (key !== built) { build(w, h, phone); built = key; }
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0; // paused time does not jump the field on return
      if (!still) clock += dt;
      last = now;
      const ease = still ? 1 : 1 - Math.exp(-dt * 2.2);
      for (let i = 0; i < 9; i++) cur[i] += (target[i] - cur[i]) * ease;
      if (!still) { mx += (tx - mx) * 0.04; my += (ty - my) * 0.04; }
      const asp = w / h;
      gl.viewport(0, 0, bw, bh);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(U.uT, clock);
      gl.uniform1f(U.uPx, bh / 2);
      gl.uniform1f(U.uAsp, asp);
      gl.uniform3f(U.uKey, cur[0], cur[1], cur[2]); gl.uniform3f(U.uRim, cur[3], cur[4], cur[5]); gl.uniform3f(U.uAcc, cur[6], cur[7], cur[8]);
      if (phone) {
        // upright, smaller, down the right edge and partly off it; fewer, bigger, softer particles; the copy side veiled
        gl.uniform1f(U.uGain, Math.min(1.4, Math.max(0.8, (w * h) / count / 18)) * 0.6);
        gl.uniform1f(U.uDof, 0.16);
        gl.uniform4f(U.uRot, 0.1 + Math.sin(clock * 0.05) * 0.02, -0.2 + Math.sin(clock * 0.037) * 0.03, 0, 0);
        gl.uniform4f(U.uFrame, 0.68, 0, 0.6, 2.6);
        gl.uniform3f(U.uVeil, -0.6, 0.45, 0.35);
      } else {
        // the helix right of the copy, the copy side veiled
        gl.uniform1f(U.uGain, (asp < 0.9 ? 0.9 : 1) * Math.min(2.2, Math.max(0.8, (w * h) / count / 26)) * 0.75); // fewer particles than area: each brighter
        gl.uniform1f(U.uDof, 0.22);
        gl.uniform4f(U.uRot, 0.36 + Math.sin(clock * 0.05) * 0.03, -0.42 + Math.sin(clock * 0.037) * 0.04, mx * 0.16, -my * 0.1);
        gl.uniform4f(U.uFrame, 0.42, 0.02, 1, 1);
        gl.uniform3f(U.uVeil, -0.55, 0.2, 0.16);
      }
      gl.drawArrays(gl.POINTS, 0, count);
      if (!still && visible && !document.hidden) raf = requestAnimationFrame(frame);
    };
    const kick = () => { if (!raf && !dead) raf = requestAnimationFrame(frame); };

    const io = new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible) { last = 0; kick(); } });
    io.observe(canvas);
    const ro = new ResizeObserver(kick); // a still frame redraws on resize too
    ro.observe(canvas);
    const onVis = () => { if (!document.hidden) { last = 0; kick(); } };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const r = canvas.getBoundingClientRect();
      tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      ty = Math.max(-1, Math.min(1, 1 - ((e.clientY - r.top) / r.height) * 2));
    };
    // preventDefault lets the browser restore the context; then the field is set up again (the buffer is rebuilt)
    const onLost = (e: Event) => { e.preventDefault(); dead = true; cancelAnimationFrame(raf); raf = 0; };
    const onRestored = () => { if (!init()) { fail(); return; } dead = false; built = -1; last = 0; kick(); };
    document.addEventListener("visibilitychange", onVis);
    addEventListener("pointermove", onMove, { passive: true });
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    kick();
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      io.disconnect(); ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      removeEventListener("pointermove", onMove);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      // StrictMode and a mood change re-run this effect on the same canvas: keep its context, free only what this run made.
      // A canvas that is really gone (navigation) gives its GPU memory back now, not at GC.
      if (canvas.isConnected) { gl.deleteBuffer(buf); gl.deleteProgram(prog); }
      else gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [mood, budget]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
