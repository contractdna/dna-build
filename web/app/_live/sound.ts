// Synthesized lab sound (no audio assets). Created only after a user gesture; on by default (LiveProvider starts it on the first one).
// Chain: voices -> dry + small room reverb -> warmth lowpass -> compressor -> out.

export type Cue = "swaps" | "mev" | "testing" | "simulation" | "rejected" | "canary" | "activated" | "rollback" | "epoch";

export class LabSound {
  private master: GainNode;
  private bus: GainNode;    // voices go here
  private verb: GainNode;   // reverb send
  private hum?: { stop: () => void };
  private noise: AudioBuffer;

  constructor(private ctx: BaseAudioContext = new AudioContext()) {
    const c = ctx;
    this.noise = this.noiseBuffer(2);
    this.master = c.createGain();
    this.master.gain.value = 0;
    const warm = c.createBiquadFilter();
    warm.type = "lowpass";
    warm.frequency.value = 9000;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.25;
    this.master.connect(warm).connect(comp).connect(c.destination);

    this.bus = c.createGain();
    this.bus.connect(this.master);
    const conv = c.createConvolver();
    conv.buffer = this.room(2.2);
    this.verb = c.createGain();
    this.verb.gain.value = 0.22;
    this.bus.connect(this.verb).connect(conv).connect(this.master);
  }

  /** false while the browser still holds the audio back (no user gesture yet) */
  get running() { return !(this.ctx instanceof AudioContext) || this.ctx.state === "running"; }

  async enable() {
    if (this.ctx instanceof AudioContext) await this.ctx.resume();
    this.master.gain.setTargetAtTime(1, this.ctx.currentTime, 0.5);
    if (!this.hum) this.hum = this.startHum();
  }

  disable() {
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
    // stop burning CPU/battery once silent; enable() resumes
    if (this.ctx instanceof AudioContext) { const ctx = this.ctx; setTimeout(() => { if (this.master.gain.value < 0.01) void ctx.suspend(); }, 400); }
  }

  /** Ambient bed: low detuned drone + airy band of noise, breathing with the cell (6.5 s). */
  private startHum() {
    const c = this.ctx;
    const out = c.createGain();
    out.gain.value = 0.0057;            // a bed well under the cues (~-42 dBFS RMS)
    out.connect(this.master);
    const breath = c.createOscillator();
    breath.frequency.value = 1 / 6.5;
    const depth = c.createGain();
    depth.gain.value = 0.0013;
    breath.connect(depth).connect(out.gain);
    breath.start();
    const oscs = [55, 55.32, 110.15].map((f, i) => {
      const o = c.createOscillator();
      o.type = i === 2 ? "triangle" : "sine";
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.value = i === 2 ? 0.22 : 0.6;
      o.connect(g).connect(out);
      o.start();
      return o;
    });
    const air = c.createBufferSource();
    air.buffer = this.noise;
    air.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 850; bp.Q.value = 0.5;
    const sweep = c.createOscillator();
    sweep.frequency.value = 0.045;
    const sweepAmt = c.createGain();
    sweepAmt.gain.value = 260;
    sweep.connect(sweepAmt).connect(bp.frequency);
    sweep.start();
    const ag = c.createGain();
    ag.gain.value = 0.09;
    air.connect(bp).connect(ag).connect(out);
    air.start();
    return { stop: () => { [...oscs, breath, sweep].forEach((o) => o.stop()); air.stop(); } };
  }

  // ---------- cues ----------

  play(cue: Cue, arg = 0) {
    switch (cue) {
      case "swaps": {
        const k = Math.min(6, Math.max(1, Math.round(Math.log2(arg + 1))));
        for (let i = 0; i < k; i++) this.tick(i * (0.09 + Math.random() * 0.12), 2300 + Math.random() * 900, 0.011 + Math.random() * 0.007);
        break;
      }
      case "mev":
        this.tone(3100, 3100, 0.07, 0.06, "sine");
        this.tone(3330, 3330, 0.07, 0.044, "sine", 0.075);
        break;
      case "testing":
        this.sweep(500, 2600, 1.1, 0.12);
        break;
      case "simulation":
        // glassy bell: inharmonic partials
        [1, 2.76, 5.4].forEach((p, i) => this.tone(880 * p, 880 * p, 1.9 / (i + 1), 0.04 / (i + 1.4), "sine", i * 0.004));
        break;
      case "rejected":
        this.tone(784, 784, 0.32, 0.045, "triangle");
        this.tone(659.3, 659.3, 0.5, 0.045, "triangle", 0.16);
        this.tick(0.62, 1400, 0.03); // the pinch-off
        break;
      case "canary":
        this.tone(220, 220, 0.9, 0.04, "sine");
        this.tone(329.6, 329.6, 1.1, 0.04, "sine", 0.18);
        this.tone(659.3, 659.3, 1.2, 0.012, "sine", 0.2);
        break;
      case "activated":
        [220, 277.2, 329.6, 440].forEach((f, i) => this.tone(f, f, 2.2, 0.03, "sine", i * 0.03, 0.12));
        break;
      case "rollback":
        this.tone(78, 36, 0.7, 0.32, "sine");
        this.noiseHit(0.0, 300, 0.09, 0.25);
        this.tone(466.2, 466.2, 0.45, 0.022, "sawtooth", 0.02);
        this.tone(493.9, 493.9, 0.45, 0.022, "sawtooth", 0.02);
        break;
      case "epoch":
        this.pad([110, 165, 220, 330], 3.6, 0.03);
        break;
    }
  }

  // ---------- voices ----------

  private noiseBuffer(seconds: number) {
    const b = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * seconds), this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  /** Small, dark room: stereo exponentially decaying noise. */
  private room(seconds: number) {
    const rate = this.ctx.sampleRate, n = Math.floor(rate * seconds);
    const b = this.ctx.createBuffer(2, n, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.2) * (i < rate * 0.01 ? i / (rate * 0.01) : 1);
    }
    return b;
  }

  private env(g: GainNode, t: number, peak: number, attack: number, dur: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  private tone(freq: number, to: number, dur: number, peak: number, type: OscillatorType = "sine", delay = 0, attack = 0.012) {
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to !== freq) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    this.env(g, t, peak, attack, dur);
    let node: AudioNode = o.connect(g);
    if (type === "sawtooth" || type === "square") {
      const lp = c.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 1800;
      node = node.connect(lp);
    }
    node.connect(this.bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Soft tonal tick: a pitched blip with a breath of filtered noise. */
  private tick(delay: number, freq: number, peak: number) {
    this.tone(freq, freq * 0.98, 0.06, peak, "sine", delay, 0.003);
    this.noiseHit(delay, freq * 1.4, 0.03, peak * 0.6, "highpass");
  }

  private noiseHit(delay: number, freq: number, dur: number, peak: number, type: BiquadFilterType = "lowpass") {
    const c = this.ctx, t = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    const g = c.createGain();
    this.env(g, t, peak, 0.002, dur);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  private sweep(from: number, to: number, dur: number, peak: number) {
    const c = this.ctx, t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass"; bp.Q.value = 6;
    bp.frequency.setValueAtTime(from, t);
    bp.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    this.env(g, t, peak, dur * 0.6, dur);
    src.connect(bp).connect(g).connect(this.bus);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  private pad(freqs: number[], dur: number, peak: number) {
    const c = this.ctx, t = c.currentTime;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(2400, t + dur * 0.7);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g).connect(this.bus);
    freqs.forEach((f) => [-4, 4].forEach((cents) => {
      const o = c.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      o.detune.value = cents;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }));
  }

  /** Debug: render each cue offline and report peak / RMS in dBFS (objective level check). */
  static async analyze(cues: Cue[] = ["swaps", "mev", "testing", "simulation", "rejected", "canary", "activated", "rollback", "epoch"]) {
    const db = (x: number) => (x > 0 ? +(20 * Math.log10(x)).toFixed(1) : -Infinity);
    const out: Record<string, { peak: number; rms: number }> = {};
    for (const cue of [...cues, "hum" as const]) {
      const ctx = new OfflineAudioContext(2, 48000 * 4, 48000);
      const s = new LabSound(ctx);
      s.master.gain.value = 1;
      if (cue === "hum") s.hum = s.startHum(); else s.play(cue, 150);
      const buf = await ctx.startRendering();
      let peak = 0, sum = 0;
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); peak = Math.max(peak, v); sum += v * v; }
      out[cue] = { peak: db(peak), rms: db(Math.sqrt(sum / d.length)) };
    }
    return out;
  }
}
