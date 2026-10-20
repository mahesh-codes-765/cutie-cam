// Cartoon (cel-shading) filter for the camera picture, run on the GPU with WebGL.
// Smooths skin and walls into flat colour bands and draws dark ink lines on edges,
// so the real room, hair and clothes match the cartoon face painted on top.

const VERT = `
attribute vec2 a;
varying vec2 vPos;
void main() {
  vPos = (a + 1.0) * 0.5;
  gl_Position = vec4(a, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec2 vPos;
uniform sampler2D uTex;
uniform vec2 uOut;      // output size in px
uniform vec4 uRect;     // video placement in output px: ox, oy, dw, dh
uniform vec2 uTexel;    // one video pixel in uv
uniform float uMirror;

vec3 px(vec2 uv) { return texture2D(uTex, uv).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 p = vec2(vPos.x, 1.0 - vPos.y) * uOut;
  if (uMirror > 0.5) p.x = uOut.x - p.x;
  vec2 uv = (p - uRect.xy) / uRect.zw;

  // edge-preserving smoothing (colour-weighted 3x3 at a 2px radius)
  vec3 c0 = px(uv);
  vec3 sum = c0;
  float wsum = 1.0;
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      if (i == 0 && j == 0) continue;
      vec3 c = px(uv + vec2(float(i), float(j)) * uTexel * 2.0);
      float w = exp(-dot(c - c0, c - c0) * 40.0);
      sum += c * w;
      wsum += w;
    }
  }
  vec3 col = sum / wsum;

  // posterize brightness into soft bands, keep the colour, add a little pop
  float l = luma(col);
  float bands = 6.0;
  float lq = floor(l * bands + 0.5) / bands;
  lq = mix(l, lq, 0.75);
  col *= lq / max(l, 0.02);
  float g = luma(col);
  col = clamp(mix(vec3(g), col, 1.25), 0.0, 1.0);

  // ink lines from a Sobel edge pass on brightness
  vec2 t = uTexel * 1.5;
  float tl = luma(px(uv + vec2(-t.x, -t.y))), tc = luma(px(uv + vec2(0.0, -t.y))), tr = luma(px(uv + vec2(t.x, -t.y)));
  float ml = luma(px(uv + vec2(-t.x, 0.0))),                                         mr = luma(px(uv + vec2(t.x, 0.0)));
  float bl = luma(px(uv + vec2(-t.x, t.y))),  bc = luma(px(uv + vec2(0.0, t.y))),  br = luma(px(uv + vec2(t.x, t.y)));
  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  float edge = smoothstep(0.22, 0.5, length(vec2(gx, gy)));
  col = mix(col, vec3(0.16, 0.11, 0.13), edge * 0.85);

  gl_FragColor = vec4(col, 1.0);
}`;

export class ToonFilter {
  constructor(width, height) {
    this.ok = false;
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    try {
      const gl = this.canvas.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (!gl) return;
      this.gl = gl;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      this.prog = prog;

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "a");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      this.u = {};
      for (const n of ["uTex", "uOut", "uRect", "uTexel", "uMirror"]) this.u[n] = gl.getUniformLocation(prog, n);
      this.ok = true;
    } catch (e) {
      console.error("Toon filter unavailable", e);
      this.ok = false;
    }
  }

  // rect: video placement in OUTPUT pixels of the main canvas (ox, oy, dw, dh); outW/outH: main canvas size
  render(video, rect, outW, outH, mirror) {
    if (!this.ok) return false;
    const gl = this.gl;
    const sx = this.canvas.width / outW, sy = this.canvas.height / outH;
    try {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      gl.uniform1i(this.u.uTex, 0);
      gl.uniform2f(this.u.uOut, this.canvas.width, this.canvas.height);
      gl.uniform4f(this.u.uRect, rect.ox * sx, rect.oy * sy, rect.dw * sx, rect.dh * sy);
      gl.uniform2f(this.u.uTexel, 1 / (video.videoWidth || video.width || 720), 1 / (video.videoHeight || video.height || 1280));
      gl.uniform1f(this.u.uMirror, mirror ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    } catch (e) {
      console.error(e);
      this.ok = false;
      return false;
    }
  }
}
