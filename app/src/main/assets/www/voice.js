// Voice changer graph:
// mic ─┬─ effects (pitch + robot) ─ wet ─┐
//      └──────────────────────── dry ──┴─ sum ─┬────────────── master ─ limiter ─┬─ recorder stream
//                                             └─ echo loop ─ echoWet ─┘          └─ monitor (earphones)

export const PRESETS = [
  { id: "normal",   name: "Normal",   pitch: 0,  robot: 0,    echo: 0,    real: 0 },
  { id: "chipmunk", name: "Chipmunk", pitch: 9,  robot: 0,    echo: 0,    real: 0 },
  { id: "cartoon",  name: "Cartoon",  pitch: 5,  robot: 0,    echo: 0.12, real: 0 },
  { id: "deep",     name: "Monster",  pitch: -8, robot: 0.1,  echo: 0.18, real: 0 },
  { id: "robot",    name: "Robot",    pitch: -1, robot: 0.85, echo: 0.05, real: 0 },
  { id: "cave",     name: "Echo",     pitch: 2,  robot: 0,    echo: 0.7,  real: 0 },
];

export class Voice {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.settings = { pitch: 5, robot: 0, echo: 0.12, real: 0 };
  }

  async init(micStream) {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule("voice-worklet.js");

    this.src = ctx.createMediaStreamSource(micStream);
    this.fx = new AudioWorkletNode(ctx, "cutie-voice", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();
    this.sum = ctx.createGain();
    this.master = ctx.createGain();
    this.master.gain.value = 1.15;

    this.delay = ctx.createDelay(1.5);
    this.fb = ctx.createGain();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = "lowpass";
    this.tone.frequency.value = 3200;
    this.echoWet = ctx.createGain();

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.15;

    this.dest = ctx.createMediaStreamDestination();
    this.monitor = ctx.createGain();
    this.monitor.gain.value = 0;

    this.src.connect(this.fx).connect(this.wet).connect(this.sum);
    this.src.connect(this.dry).connect(this.sum);
    this.sum.connect(this.master);
    this.sum.connect(this.delay);
    this.delay.connect(this.tone);
    this.tone.connect(this.fb).connect(this.delay);
    this.tone.connect(this.echoWet).connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(this.dest);
    this.limiter.connect(this.monitor).connect(ctx.destination);

    this.ready = true;
    this.apply(this.settings);
  }

  resume() {
    if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  }

  apply(s) {
    this.settings = { ...this.settings, ...s };
    if (!this.ready) return;
    const { pitch, robot, echo, real } = this.settings;
    const t = this.ctx.currentTime;
    const set = (param, v) => param.setTargetAtTime(v, t, 0.03);
    set(this.fx.parameters.get("ratio"), Math.pow(2, pitch / 12));
    set(this.fx.parameters.get("robot"), robot);
    set(this.wet.gain, 1 - real);
    set(this.dry.gain, real);
    set(this.fb.gain, echo * 0.55);
    set(this.echoWet.gain, echo * 0.85);
    set(this.delay.delayTime, 0.12 + echo * 0.2);
  }

  setMonitor(on) {
    if (!this.ready) return;
    this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  get track() {
    return this.ready ? this.dest.stream.getAudioTracks()[0] : null;
  }

  // Records a few seconds of the changed voice and plays it back (works without earphones).
  async test(seconds, onState) {
    if (!this.ready) return;
    this.resume();
    const rec = new MediaRecorder(this.dest.stream);
    const parts = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start();
    onState && onState("listening");
    await new Promise((r) => setTimeout(r, seconds * 1000));
    rec.stop();
    await done;
    onState && onState("playing");
    const url = URL.createObjectURL(new Blob(parts, { type: rec.mimeType }));
    const audio = new Audio(url);
    await new Promise((r) => {
      audio.onended = r;
      audio.onerror = r;
      audio.play().catch(r);
    });
    URL.revokeObjectURL(url);
    onState && onState("idle");
  }
}
