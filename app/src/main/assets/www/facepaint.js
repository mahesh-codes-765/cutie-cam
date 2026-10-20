// AnimeGANv2 "face paint" generator (bryandlee/animegan2-pytorch, face_paint_512_v2),
// re-implemented with TensorFlow.js ops so it runs on the phone's GPU inside the app.
// Weights: ai/face_paint_v2.bin (float16) + ai/face_paint_v2.json (names, shapes, offsets).
// Input and output: NHWC float tensors in [-1, 1].

/* global tf */

function halfToFloat(h) {
  const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : (s ? -1 : 1) * Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

export class FacePaint {
  static async load(base = "ai/face_paint_v2") {
    const [meta, buf] = await Promise.all([
      fetch(base + ".json").then((r) => { if (!r.ok) throw new Error("model json " + r.status); return r.json(); }),
      fetch(base + ".bin").then((r) => { if (!r.ok) throw new Error("model bin " + r.status); return r.arrayBuffer(); }),
    ]);
    const half = new Uint16Array(buf);
    const lut = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) lut[i] = halfToFloat(i);
    const raw = {};
    for (const t of meta.tensors) {
      const a = new Float32Array(t.length);
      for (let i = 0; i < t.length; i++) a[i] = lut[half[t.offset + i]];
      raw[t.name] = { data: a, shape: t.shape };
    }
    return new FacePaint(raw);
  }

  constructor(raw) {
    this.w = {};
    const T = (name) => raw[name];
    // turn PyTorch layouts into TF.js layouts once, keep them on the GPU
    for (const [name, r] of Object.entries(raw)) {
      const t = tf.tensor(r.data, r.shape);
      if (r.shape.length === 4) {
        const depthwise = r.shape[1] === 1 && r.shape[0] > 3; // [C,1,k,k]
        this.w[name] = depthwise ? tf.transpose(t, [2, 3, 0, 1]) : tf.transpose(t, [2, 3, 1, 0]);
        this.w[name].depthwise = depthwise;
        t.dispose();
      } else {
        this.w[name] = t.reshape([1, 1, 1, -1]);
        t.dispose();
      }
    }
    void T;
  }

  // ConvNormLReLU: reflect pad -> conv -> GroupNorm(1) -> LeakyReLU(0.2)
  cnl(x, p, { pad = 1, stride = 1 } = {}) {
    const [l, r, t, b] = Array.isArray(pad) ? pad : [pad, pad, pad, pad];
    if (l || r || t || b) x = tf.mirrorPad(x, [[0, 0], [t, b], [l, r], [0, 0]], "reflect");
    const k = this.w[p + ".1.weight"];
    x = k.depthwise ? tf.depthwiseConv2d(x, k, stride, "valid") : tf.conv2d(x, k, stride, "valid");
    const bias = this.w[p + ".1.bias"];
    if (bias) x = tf.add(x, bias);
    x = this.gn(x, p + ".2");
    return tf.leakyRelu(x, 0.2);
  }

  gn(x, p) {
    const { mean, variance } = tf.moments(x, [1, 2, 3], true);
    x = tf.div(tf.sub(x, mean), tf.sqrt(tf.add(variance, 1e-5)));
    return tf.add(tf.mul(x, this.w[p + ".weight"]), this.w[p + ".bias"]);
  }

  // InvertedResBlock (expansion 2)
  irb(x, p) {
    const inC = x.shape[3];
    let y = this.cnl(x, p + ".layers.0", { pad: 0 });          // 1x1 expand
    y = this.cnl(y, p + ".layers.1", { pad: 1 });              // 3x3 depthwise
    y = tf.conv2d(y, this.w[p + ".layers.2.weight"], 1, "valid"); // 1x1 project
    y = this.gn(y, p + ".layers.3");
    return inC === y.shape[3] ? tf.add(x, y) : y;
  }

  // x: [1, H, W, 3] in [-1, 1]; H and W should be multiples of 4
  forward(x) {
    return tf.tidy(() => {
      const H = x.shape[1], W = x.shape[2];
      let o = this.cnl(x, "block_a.0", { pad: 3 });
      o = this.cnl(o, "block_a.1", { pad: [0, 1, 0, 1], stride: 2 });
      o = this.cnl(o, "block_a.2");
      const half = [o.shape[1], o.shape[2]];
      o = this.cnl(o, "block_b.0", { pad: [0, 1, 0, 1], stride: 2 });
      o = this.cnl(o, "block_b.1");
      o = this.cnl(o, "block_c.0");
      for (let i = 1; i <= 4; i++) o = this.irb(o, "block_c." + i);
      o = this.cnl(o, "block_c.5");
      o = tf.image.resizeBilinear(o, half, true);
      o = this.cnl(o, "block_d.0");
      o = this.cnl(o, "block_d.1");
      o = tf.image.resizeBilinear(o, [H, W], true);
      o = this.cnl(o, "block_e.0");
      o = this.cnl(o, "block_e.1");
      o = this.cnl(o, "block_e.2", { pad: 3 });
      o = tf.conv2d(o, this.w["out_layer.0.weight"], 1, "valid");
      return tf.tanh(o);
    });
  }

  /**
   * Cartoonize a square canvas (or image) and draw the result into `out` (a canvas of the same size).
   * Returns a promise; resolves when the pixels are in `out`.
   */
  async paint(src, out) {
    const size = out.width;
    const y = tf.tidy(() => {
      const img = tf.browser.fromPixels(src).toFloat();
      const x = img.div(127.5).sub(1).expandDims(0);
      return this.forward(x).squeeze([0]).add(1).mul(0.5).clipByValue(0, 1);
    });
    await tf.browser.toPixels(y, out);
    y.dispose();
    return size;
  }

  // Warm up shaders so the first real frame isn't slow. On WebGL the GPU programs are
  // compiled in parallel (KHR_parallel_shader_compile) so the screen doesn't freeze.
  async warmup(size) {
    if (tf.getBackend() === "webgl" && !this.compiled) {
      this.compiled = true;
      try {
        const be = tf.backend();
        tf.env().set("ENGINE_COMPILE_ONLY", true);
        const x = tf.zeros([1, size, size, 3]);
        const y = this.forward(x);
        tf.env().set("ENGINE_COMPILE_ONLY", false);
        await be.checkCompileCompletionAsync();
        be.getUniformLocations();
        tf.dispose([x, y]);
      } catch (e) {
        tf.env().set("ENGINE_COMPILE_ONLY", false);
        console.warn("parallel shader compile not available", e);
      }
    }
    const c = document.createElement("canvas");
    c.width = c.height = size;
    await this.paint(c, c);
  }
}
