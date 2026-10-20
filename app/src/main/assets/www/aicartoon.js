// AI cartoon face: crops the head out of the frame (upright, centred), runs the
// face-paint model on it, and blends the cartoon head back with a soft-edged mask.
// The cartoon crop remembers where the head was, so between AI frames it is
// re-placed on the head's *current* position and keeps following her movements.

/* global tf */
import { FacePaint } from "./facepaint.js";

const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Head placement (centre, size, tilt) from face-mesh points in frame pixels. */
export function headPose(pts) {
  let cx = 0, cy = 0;
  for (const i of OVAL) { cx += pts[i].x; cy += pts[i].y; }
  cx /= OVAL.length; cy /= OVAL.length;
  const faceH = Math.hypot(pts[10].x - pts[152].x, pts[10].y - pts[152].y);
  const faceW = Math.hypot(pts[234].x - pts[454].x, pts[234].y - pts[454].y);
  let roll = Math.atan2(pts[263].y - pts[33].y, pts[263].x - pts[33].x);
  if (roll > Math.PI / 2) roll -= Math.PI;
  else if (roll < -Math.PI / 2) roll += Math.PI;
  const size = Math.max(faceH * 2.05, faceW * 2.3);
  // move the crop centre slightly up the face so hair is included
  const up = faceH * 0.08;
  return { x: cx + Math.sin(roll) * up, y: cy - Math.cos(roll) * up, size, roll, faceH };
}

export class AICartoon {
  constructor() {
    this.ready = false;
    this.failed = false;
    this.model = null;
    this.busy = false;
    this.backend = "";
    this.res = 160;            // live crop resolution, adapted to the phone's speed
    this.avgMs = 0;
    this.last = null;          // { canvas, pose, at }
    this.crop = document.createElement("canvas");
    this.mask = null;
  }

  async init(onStatus) {
    try {
      onStatus && onStatus("Loading AI…");
      if (typeof tf === "undefined") throw new Error("TensorFlow.js missing");
      let ok = false;
      if (navigator.gpu && tf.findBackend && tf.findBackend("webgpu")) {
        try { ok = await tf.setBackend("webgpu"); } catch (e) { ok = false; }
      }
      if (!ok) ok = await tf.setBackend("webgl");
      if (!ok) await tf.setBackend("cpu");
      await tf.ready();
      this.backend = tf.getBackend();
      if (this.backend === "webgl") {
        // one set of GPU programs for every input size (no re-compiling when the resolution adapts)
        tf.env().set("WEBGL_USE_SHAPES_UNIFORMS", true);
      }
      this.model = await FacePaint.load("ai/face_paint_v2");
      onStatus && onStatus("Warming up AI…");
      await this.model.warmup(96);
      // quick speed probe to pick a starting resolution
      const t0 = performance.now();
      await this.model.warmup(128);
      const ms128 = performance.now() - t0;
      this.avgMs = ms128;
      this.res = ms128 < 60 ? 224 : ms128 < 110 ? 192 : ms128 < 180 ? 160 : ms128 < 300 ? 128 : 96;
      this.ready = true;
    } catch (e) {
      console.error("AI cartoon unavailable", e);
      this.failed = true;
    }
    return this.ready;
  }

  /** Copy the upright head square out of `src` (frame-sized canvas) into a res x res canvas. */
  cropHead(src, pose, res, into) {
    const c = into || document.createElement("canvas");
    c.width = c.height = res;
    const x = c.getContext("2d");
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = "#808080";
    x.fillRect(0, 0, res, res);
    x.translate(res / 2, res / 2);
    x.scale(res / pose.size, res / pose.size);
    x.rotate(-pose.roll);
    x.translate(-pose.x, -pose.y);
    x.drawImage(src, 0, 0);
    x.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  }

  softMask(res) {
    if (this.mask && this.mask.width === res) return this.mask;
    const m = document.createElement("canvas");
    m.width = m.height = res;
    const x = m.getContext("2d");
    x.translate(res / 2, res * 0.5);
    x.scale(0.8, 1); // taller than wide, like a head with hair
    const g = x.createRadialGradient(0, 0, res * 0.34, 0, 0, res * 0.5);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g;
    x.fillRect(-res, -res, res * 2, res * 2);
    this.mask = m;
    return m;
  }

  /** Run the model on a head crop; returns a canvas with the soft-edged cartoon head. */
  async paintCrop(cropCanvas) {
    const res = cropCanvas.width;
    const out = document.createElement("canvas");
    out.width = out.height = res;
    await this.model.paint(cropCanvas, out);
    const x = out.getContext("2d");
    x.globalCompositeOperation = "destination-in";
    x.drawImage(this.softMask(res), 0, 0);
    x.globalCompositeOperation = "source-over";
    return out;
  }

  /** Live: start an AI frame if the model is free. `src` is the raw (mirrored) frame canvas. */
  tick(src, pose) {
    if (!this.ready || this.busy || !pose) return;
    this.busy = true;
    const res = this.res;
    const crop = this.cropHead(src, pose, res, this.crop);
    const t0 = performance.now();
    const p = { ...pose };
    this.paintCrop(crop).then((canvas) => {
      const ms = performance.now() - t0;
      this.avgMs = this.avgMs ? this.avgMs * 0.8 + ms * 0.2 : ms;
      this.last = { canvas, pose: p, at: performance.now() };
      this.adapt();
    }).catch((e) => {
      console.error(e);
    }).finally(() => { this.busy = false; });
  }

  adapt() {
    const steps = [96, 128, 160, 192, 224, 256];
    let i = steps.indexOf(this.res);
    if (i < 0) i = 2;
    if (this.avgMs > 230 && i > 0) { this.res = steps[i - 1]; this.avgMs *= 0.6; }
    else if (this.avgMs < 85 && i < steps.length - 1) { this.res = steps[i + 1]; this.avgMs *= 1.5; }
  }

  /** Is there a recent cartoon head that can be shown? */
  fresh(maxAgeMs = 600) {
    return !!this.last && performance.now() - this.last.at < maxAgeMs;
  }

  /** Draw a cartoon head canvas onto ctx at the head's current pose. */
  static place(ctx, headCanvas, pose) {
    const res = headCanvas.width;
    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.roll);
    ctx.scale(pose.size / res, pose.size / res);
    ctx.drawImage(headCanvas, -res / 2, -res / 2);
    ctx.restore();
  }

  drawLive(ctx, pose) {
    if (!this.last) return false;
    // keep the size from the frame it was made for, follow position and tilt live
    const p = { ...pose, size: clamp(pose.size, this.last.pose.size * 0.8, this.last.pose.size * 1.25) };
    AICartoon.place(ctx, this.last.canvas, p);
    return true;
  }
}
