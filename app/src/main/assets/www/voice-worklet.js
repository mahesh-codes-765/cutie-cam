// Real-time voice effects that run on the audio thread.
// Pitch shift keeps talking speed the same (two crossfaded read heads over a short delay line).
// Robot = ring modulation + a short metallic comb filter.

class CutieVoice extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "ratio", defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: "k-rate" },
      { name: "robot", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.W = Math.round(sampleRate * 0.042); // grain window
    this.minD = Math.round(sampleRate * 0.002);
    this.size = 1 << 15;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.phase = 0;
    this.ring = 0;
    this.comb = new Float32Array(Math.max(8, Math.round(sampleRate * 0.0075)));
    this.ci = 0;
  }

  read(d) {
    let pos = this.w - d;
    while (pos < 0) pos += this.size;
    const i0 = Math.floor(pos);
    const fr = pos - i0;
    const i1 = (i0 + 1) & (this.size - 1);
    return this.buf[i0] * (1 - fr) + this.buf[i1] * fr;
  }

  process(inputs, outputs, params) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const inp = inputs[0] && inputs[0][0];
    const o = out[0];
    const n = o.length;
    const ratio = params.ratio[0];
    const robot = params.robot[0];
    const W = this.W;
    const step = (1 - ratio) / W;
    const shifting = Math.abs(ratio - 1) > 0.001;
    const ringInc = (2 * Math.PI * 52) / sampleRate;
    const comb = this.comb;

    for (let i = 0; i < n; i++) {
      const x = inp ? inp[i] : 0;
      this.buf[this.w] = x;
      let y = x;
      if (shifting) {
        const p1 = this.phase - Math.floor(this.phase);
        let p2 = p1 + 0.5;
        if (p2 >= 1) p2 -= 1;
        const s1 = Math.sin(Math.PI * p1);
        const s2 = Math.sin(Math.PI * p2);
        y = s1 * s1 * this.read(this.minD + W * p1) + s2 * s2 * this.read(this.minD + W * p2);
        this.phase += step;
        if (this.phase > 1e6 || this.phase < -1e6) this.phase -= Math.floor(this.phase);
      }
      if (robot > 0.001) {
        this.ring += ringInc;
        if (this.ring > 6.283185307) this.ring -= 6.283185307;
        const ringed = y * (1 - robot) + y * Math.sin(this.ring) * robot * 1.7;
        const z = ringed + comb[this.ci] * 0.6 * robot;
        comb[this.ci] = z;
        this.ci = (this.ci + 1) % comb.length;
        y = z * (1 - 0.3 * robot);
      }
      o[i] = y;
      this.w = (this.w + 1) & (this.size - 1);
    }
    for (let c = 1; c < out.length; c++) out[c].set(o);
    return true;
  }
}

registerProcessor("cutie-voice", CutieVoice);
