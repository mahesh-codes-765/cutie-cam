import { drawGirl, makeHair, updateHair, neutralState } from "./girl.js";
import { Voice, PRESETS } from "./voice.js";
import { ToonFilter } from "./toon.js";
import { drawToonFace, makeToonState } from "./toonface.js";
import { AICartoon, headPose } from "./aicartoon.js";
import { loadHDLibs, hdSupported, planHD, convertHD } from "./hd.js";

const W = 720, H = 1280; // 9:16, Instagram Reels size (scaled 720p)
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const native = window.CutieNative || null;

/* ------------------------------------------------------------------ */
/* Welcome hero                                                        */
/* ------------------------------------------------------------------ */
const hero = $("hero"), hctx = hero.getContext("2d");
const heroHair = makeHair();
let heroOn = true;
function heroLoop(t) {
  if (!heroOn) return;
  hctx.clearRect(0, 0, 380, 380);
  const s = neutralState(190, 170, 118);
  const ph = (t / 1000) % 4.5;
  s.bL = s.bR = ph > 4.25 ? 1 : 0;
  s.jaw = ph > 1 && ph < 2.4 ? (Math.sin((ph - 1) * Math.PI * 3.2) * 0.5 + 0.5) * 0.45 : 0;
  s.smile = ph > 2.8 && ph < 4 ? 0.8 : 0.35;
  s.roll = Math.sin(t / 900) * 0.12;
  updateHair(heroHair, s, 1);
  drawGirl(hctx, s, heroHair, { body: true });
  requestAnimationFrame(heroLoop);
}
requestAnimationFrame(heroLoop);

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const video = $("cam");
const canvas = $("stage"), ctx = canvas.getContext("2d");
let mode = store.get("cutiecam-mode", "room"); // "room" | "scene"
// "ai" (AI redraws her face as a cartoon) | "toon" (cartoon face painted on her face) | "mask" (chibi girl)
let style = store.get("cutiecam-style2", "ai");
let hd = store.get("cutiecam-hd", true);   // AI style: convert in HD after recording
const ai = new AICartoon();
let aiStarted = false;
let converting = false;
// the frame source: the camera, or a recorded clip being re-processed
let src = video, srcMirror = true, replaying = false;
// mirrored, un-filtered camera frame (AI crops and HD recordings come from here)
const rawCanvas = document.createElement("canvas");
rawCanvas.width = W; rawCanvas.height = H;
const rawCtx = rawCanvas.getContext("2d");
let pts = null; // smoothed face-mesh points in canvas pixels
const toonState = makeToonState();
const toon = new ToonFilter(540, 960);
let skinRGB = [242, 196, 160], skinFrames = 0;
let facing = "user";
let videoStream = null, micStream = null;
let landmarker = null, trackerFailed = false, gpuErrors = 0, usingGpu = true;
let lastVideoTime = -1, lastTs = 0, lastSeen = -1e9, seenOnce = false;
let target = null;
let recording = false;
const st = neutralState(W / 2, H * 0.42, 200);
const hair = makeHair();
const voice = new Voice();

/* ------------------------------------------------------------------ */
/* Face tracker (MediaPipe, bundled offline inside the app)            */
/* ------------------------------------------------------------------ */
async function loadTracker(useGpu) {
  const mp = await import("./mediapipe/vision_bundle.js");
  const files = await mp.FilesetResolver.forVisionTasks(new URL("mediapipe/wasm", location.href).href);
  return mp.FaceLandmarker.createFromOptions(files, {
    baseOptions: {
      modelAssetPath: new URL("mediapipe/face_landmarker.task", location.href).href,
      delegate: useGpu ? "GPU" : "CPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: true,
  });
}
async function startTracker() {
  try {
    landmarker = await loadTracker(true);
  } catch (e) {
    try { usingGpu = false; landmarker = await loadTracker(false); }
    catch (e2) { trackerFailed = true; console.error(e2); }
  }
}

function cover() {
  const vw = src.videoWidth || 720, vh = src.videoHeight || 1280;
  const sc = Math.max(W / vw, H / vh);
  const dw = vw * sc, dh = vh * sc;
  return { ox: (W - dw) / 2, oy: (H - dh) / 2, dw, dh };
}

function readFace(res) {
  const lm = res.faceLandmarks && res.faceLandmarks[0];
  if (!lm) return null;
  const { ox, oy, dw, dh } = cover();
  const mx = (x) => (srcMirror ? 1 - x : x); // selfie view is mirrored
  const P = (i) => ({ x: ox + mx(lm[i].x) * dw, y: oy + lm[i].y * dh });
  const L = P(234), Rr = P(454), T = P(10), B = P(152), N = P(1), E1 = P(33), E2 = P(263);
  const w = Math.hypot(L.x - Rr.x, L.y - Rr.y);
  const h = Math.hypot(T.x - B.x, T.y - B.y);
  let roll = Math.atan2(E1.y - E2.y, E1.x - E2.x);
  if (roll > Math.PI / 2) roll -= Math.PI; // a head is never upside down: keep tilt within ±90°
  else if (roll < -Math.PI / 2) roll += Math.PI;
  const ux = Math.cos(roll), uy = Math.sin(roll);
  let cx = ((L.x + Rr.x) / 2 + (T.x + B.x) / 2) / 2;
  let cy = ((L.y + Rr.y) / 2 + (T.y + B.y) / 2) / 2;
  // nudge the cartoon head up a little so it also covers her forehead and hairline
  cx += uy * h * 0.08; cy -= ux * h * 0.08;
  const dx = N.x - cx, dy = N.y - cy;
  const bs = {};
  for (const c of (res.faceBlendshapes && res.faceBlendshapes[0] ? res.faceBlendshapes[0].categories : [])) bs[c.categoryName] = c.score;
  return {
    pts: lm.map((p) => ({ x: ox + mx(p.x) * dw, y: oy + p.y * dh })),
    x: cx, y: cy, R: Math.max(w * 0.74, h * 0.68), roll,
    yaw: clamp(((dx * ux + dy * uy) / w) * 1.6, -0.4, 0.4),
    pitch: clamp(((-dx * uy + dy * ux) / h) * 1.2, -0.3, 0.3),
    bL: bs.eyeBlinkLeft || 0, bR: bs.eyeBlinkRight || 0,
    jaw: bs.jawOpen || 0,
    smile: ((bs.mouthSmileLeft || 0) + (bs.mouthSmileRight || 0)) / 2,
    brow: bs.browInnerUp || 0,
    pucker: bs.mouthPucker || 0,
  };
}

function smoothTo(t) {
  if (!seenOnce || !pts || pts.length !== t.pts.length) {
    pts = t.pts.map((p) => ({ ...p }));
  } else {
    for (let i = 0; i < pts.length; i++) {
      pts[i].x += (t.pts[i].x - pts[i].x) * 0.62;
      pts[i].y += (t.pts[i].y - pts[i].y) * 0.62;
    }
  }
  if (!seenOnce) { const { pts: _, ...rest } = t; Object.assign(st, rest); seenOnce = true; return; }
  for (const k of ["x", "y", "R", "roll", "yaw", "pitch"]) st[k] += (t[k] - st[k]) * 0.6;
  for (const k of ["bL", "bR", "jaw", "smile", "brow", "pucker"]) st[k] += (t[k] - st[k]) * 0.7;
}

/* ------------------------------------------------------------------ */
/* Camera + mic                                                        */
/* ------------------------------------------------------------------ */
async function openVideo() {
  if (videoStream) videoStream.getTracks().forEach((t) => t.stop());
  videoStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  video.srcObject = videoStream;
  await video.play().catch(() => {});
  lastVideoTime = -1;
  seenOnce = false;
}

$("startBtn").onclick = async () => {
  const btn = $("startBtn"), err = $("err");
  btn.disabled = true; btn.textContent = "Opening camera…"; err.hidden = true;
  try {
    await openVideo();
  } catch (e) {
    btn.disabled = false; btn.textContent = "Try again";
    err.textContent = "Camera permission is off. Open phone Settings › Apps › Cutie Cam › Permissions, allow Camera and Microphone, then tap Try again.";
    err.hidden = false;
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await voice.init(micStream);
    voice.apply(currentVoice());
  } catch (e) {
    console.error(e);
    toast("Microphone is off, so videos will be silent.");
  }
  heroOn = false;
  $("welcome").hidden = true;
  btn.textContent = "Getting ready…";
  cameraOn = true;
  startTracker();
  ensureAI();
};

$("flipBtn").onclick = async () => {
  if (recording) return toast("Stop recording before switching camera.");
  facing = facing === "user" ? "environment" : "user";
  try { await openVideo(); }
  catch (e) { facing = "user"; await openVideo().catch(() => {}); toast("Couldn't open the other camera."); }
  if (facing === "environment") toast("Back camera: no face filter here.");
};

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */
const small = document.createElement("canvas"), sctx = small.getContext("2d");
function drawVideo(mirror, blurred) {
  const { ox, oy, dw, dh } = cover();
  if (!blurred) {
    ctx.save();
    if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(src, ox, oy, dw, dh);
    ctx.restore();
    return;
  }
  // heavy pixel-blur: shrink to 16 px wide, then stretch back up
  small.width = 16;
  small.height = Math.max(1, Math.round((16 * (src.videoHeight || 1280)) / (src.videoWidth || 720)));
  sctx.save();
  if (mirror) { sctx.translate(small.width, 0); sctx.scale(-1, 1); }
  sctx.drawImage(src, 0, 0, small.width, small.height);
  sctx.restore();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(small, ox, oy, dw, dh);
  ctx.fillStyle = "rgba(29,22,38,.35)";
  ctx.fillRect(0, 0, W, H);
}

function drawRaw() {
  const { ox, oy, dw, dh } = cover();
  rawCtx.save();
  if (srcMirror) { rawCtx.translate(W, 0); rawCtx.scale(-1, 1); }
  rawCtx.drawImage(src, ox, oy, dw, dh);
  rawCtx.restore();
}

const bokeh = Array.from({ length: 18 }, () => ({ x: Math.random(), y: Math.random(), r: 0.025 + Math.random() * 0.06, s: 0.2 + Math.random() * 0.6, p: Math.random() * 6 }));
function drawScene(t) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#ffe3ee");
  g.addColorStop(0.6, "#e9dcff");
  g.addColorStop(1, "#cdbdff");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (const b of bokeh) {
    const y = (((b.y - t * 0.00002 * b.s) % 1) + 1) % 1;
    ctx.beginPath();
    ctx.arc(b.x * W + Math.sin(t / 2000 + b.p) * 14, y * H, b.r * W, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,.35)";
    ctx.fill();
  }
}

function centerText(text) {
  ctx.save();
  ctx.fillStyle = "#fff8f2";
  ctx.textAlign = "center";
  ctx.font = "800 34px ui-rounded, Roboto, system-ui, sans-serif";
  ctx.fillText(text, W / 2, H * 0.45);
  ctx.restore();
}

/* hearts on a kissy face, sparkles on a big smile */
const parts = [];
function emit(kind) {
  if (parts.length > 50) return;
  parts.push({ kind, x: st.x + (Math.random() - 0.5) * st.R * 1.8, y: st.y - st.R * 0.2,
    vx: (Math.random() - 0.5) * st.R * 0.02, vy: -st.R * (0.012 + Math.random() * 0.012),
    life: 1, size: st.R * (0.12 + Math.random() * 0.1) });
}
function drawParts(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.x += p.vx * dt; p.y += p.vy * dt; p.life -= 0.012 * dt;
    if (p.life <= 0) { parts.splice(i, 1); continue; }
    ctx.save();
    ctx.globalAlpha = Math.min(1, p.life * 1.5);
    ctx.beginPath();
    const s = p.size;
    if (p.kind === "heart") {
      ctx.moveTo(p.x, p.y + s * 0.35);
      ctx.bezierCurveTo(p.x + s * 0.9, p.y - s * 0.25, p.x + s * 0.45, p.y - s * 0.95, p.x, p.y - s * 0.45);
      ctx.bezierCurveTo(p.x - s * 0.45, p.y - s * 0.95, p.x - s * 0.9, p.y - s * 0.25, p.x, p.y + s * 0.35);
      ctx.fillStyle = "#ff5c8a";
    } else {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4, r = k % 2 ? s * 0.22 : s * 0.8;
        ctx.lineTo(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r);
      }
      ctx.fillStyle = "#fff3a6";
    }
    ctx.fill();
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */
const statusEl = $("status"), statusText = $("statusText");
let statusKey = "";
function setStatus(cls, text) {
  const key = cls + text;
  if (key === statusKey) return;
  statusKey = key;
  statusEl.className = "status " + cls;
  statusText.textContent = text;
}

let lastT = performance.now(), emitAcc = 0;
function nextTs() {
  lastTs = Math.max(performance.now(), lastTs + 1);
  return lastTs;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = clamp((now - lastT) / 16.7, 0.2, 4);
  lastT = now;
  if (converting) return; // the HD converter is using the GPU and the face tracker
  const front = facing === "user" || replaying;
  const haveVideo = src.readyState >= 2;

  if (front && landmarker && haveVideo && src.currentTime !== lastVideoTime) {
    lastVideoTime = src.currentTime;
    try {
      target = readFace(landmarker.detectForVideo(src, nextTs()));
      gpuErrors = 0;
    } catch (e) {
      target = null;
      if (usingGpu && ++gpuErrors > 20) { // GPU path misbehaving on this phone: switch to CPU
        usingGpu = false; const old = landmarker; landmarker = null;
        try { old.close(); } catch (_) {}
        loadTracker(false).then((l) => (landmarker = l)).catch(() => (trackerFailed = true));
      }
    }
    if (target) { lastSeen = now; smoothTo(target); }
  }
  const tracking = front && now - lastSeen < 250;
  if (front && haveVideo) drawRaw();

  if (!tracking) { // relax the face while searching
    st.jaw *= 0.85; st.pucker *= 0.85; st.brow *= 0.85;
    st.bL = st.bR = (now / 1000) % 3.6 > 3.42 ? 1 : 0;
  }
  updateHair(hair, st, dt);

  if (!front) {
    if (haveVideo) drawVideo(false, false); else { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); }
  } else if (mode === "scene" && !replaying) {
    drawScene(now);
    const R = 230;
    const s = { ...st, R,
      x: W / 2 + (seenOnce ? (st.x - W / 2) * 0.45 : 0),
      y: H * 0.4 + (seenOnce ? (st.y - H * 0.42) * 0.3 : 0) };
    s.x = clamp(s.x, R, W - R);
    drawGirl(ctx, s, hair, { body: true });
  } else {
    const safe = tracking && seenOnce && !!pts;
    if (!haveVideo) { ctx.fillStyle = "#1d1626"; ctx.fillRect(0, 0, W, H); }
    else if (safe && style !== "mask" && toon.render(src, cover(), W, H, srcMirror)) ctx.drawImage(toon.canvas, 0, 0, W, H);
    else drawVideo(srcMirror, !safe);

    if (safe && style === "ai") {
      const pose = headPose(pts);
      if (ai.ready) ai.tick(rawCanvas, pose);
      if (!(ai.ready && ai.fresh() && ai.drawLive(ctx, pose))) {
        // AI still warming up (or a frame is late): the painted toon face keeps her hidden
        if (++skinFrames % 20 === 1) sampleSkin();
        drawToonFace(ctx, pts, skinLook(), st.smile, toonState);
      }
    } else if (safe && style === "toon") {
      if (++skinFrames % 20 === 1) sampleSkin();
      drawToonFace(ctx, pts, skinLook(), st.smile, toonState);
    } else if (safe) drawGirl(ctx, st, hair, { body: false });
    else if (haveVideo) centerText(trackerFailed ? "Face tracker didn't load" : "Picture blurred until your face is found");
  }

  if (tracking) {
    emitAcc += dt;
    if (emitAcc > 5) {
      emitAcc = 0;
      if (st.pucker > 0.5) emit("heart");
      else if (st.smile > 0.62) emit("spark");
    }
  }
  drawParts(dt);

  if (replaying) setStatus("rec", "Converting");
  else if (recording) setStatus("rec", "Recording");
  else if (!front) setStatus("lost", "Back camera · no filter");
  else if (trackerFailed) setStatus("lost", "Face tracker didn't load");
  else if (!landmarker) setStatus("", "Getting ready…");
  else if (tracking) setStatus("ok", faceStatus());
  else setStatus("lost", mode === "room" ? "Look at the camera · blurred" : "Look at the camera");
}

function faceStatus() {
  if (style !== "ai" || mode !== "room") return "Face hidden";
  if (ai.ready) return `Face hidden · AI ${Math.max(1, Math.round(1000 / Math.max(1, ai.avgMs)))} fps`;
  if (ai.failed) return "Face hidden · AI unavailable";
  return "Face hidden · AI loading";
}
requestAnimationFrame(frame);

/* Match the cartoon skin to her real skin tone (so face and neck blend) */
function sampleSkin() {
  try {
    let r = 0, g = 0, b = 0, n = 0;
    for (const i of [50, 280, 4]) {
      const p = pts[i];
      const d = ctx.getImageData(Math.round(p.x) - 3, Math.round(p.y) - 3, 6, 6).data;
      for (let k = 0; k < d.length; k += 4) { r += d[k]; g += d[k + 1]; b += d[k + 2]; n++; }
    }
    if (!n) return;
    const s = [r / n, g / n, b / n];
    const a = skinFrames < 5 ? 1 : 0.3;
    for (let k = 0; k < 3; k++) skinRGB[k] += (s[k] - skinRGB[k]) * a;
  } catch (e) { /* reading pixels can fail on some phones; keep the last colour */ }
}
function skinLook() {
  const mix = (c, t, k) => c.map((v, i) => Math.round(v + (t[i] - v) * k));
  const css = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  // a lighter, warmer version of her real tone; dim or odd lighting is pulled further toward a warm default
  const luma = 0.299 * skinRGB[0] + 0.587 * skinRGB[1] + 0.114 * skinRGB[2];
  const chroma = skinRGB[0] - skinRGB[2]; // skin is always redder than it is blue
  const k = clamp(0.4 + Math.max(0, 150 - luma) / 220 + (chroma < 25 ? 0.25 : 0), 0.4, 0.85);
  const base = mix(skinRGB, [250, 214, 186], k);
  return {
    skin: css(base),
    skinLight: css(mix(base, [255, 245, 238], 0.35)),
    skinShade: css(mix(base, [150, 80, 85], 0.3)),
  };
}

/* ------------------------------------------------------------------ */
/* Face style                                                          */
/* ------------------------------------------------------------------ */
function loadScript(srcUrl) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[data-src="${srcUrl}"]`)) return res();
    const el = document.createElement("script");
    el.src = srcUrl; el.dataset.src = srcUrl;
    el.onload = res;
    el.onerror = () => rej(new Error("couldn't load " + srcUrl));
    document.head.append(el);
  });
}
let cameraOn = false;
function ensureAI() {
  if (aiStarted || !cameraOn || style !== "ai") return;
  aiStarted = true;
  loadScript("lib/tf.min.js")
    .then(() => ai.init())
    .then((ok) => { if (!ok) toast("AI cartoon couldn't start on this phone, so Toon face is used instead.", 4000); })
    .catch((e) => { console.error(e); ai.failed = true; toast("AI cartoon couldn't start on this phone, so Toon face is used instead.", 4000); });
}
function syncTopTools() {
  $("hdBtn").hidden = !(style === "ai" && mode === "room");
  $("hdBtn").setAttribute("aria-pressed", hd);
  $("hdBtn").textContent = hd ? "HD on" : "HD off";
}
function setStyle(s) {
  style = s;
  store.set("cutiecam-style2", s);
  $("styleAI").setAttribute("aria-pressed", s === "ai");
  $("styleToon").setAttribute("aria-pressed", s === "toon");
  $("styleMask").setAttribute("aria-pressed", s === "mask");
  syncTopTools();
  ensureAI();
}
$("styleAI").onclick = () => setStyle("ai");
$("styleToon").onclick = () => setStyle("toon");
$("styleMask").onclick = () => setStyle("mask");
$("hdBtn").onclick = () => {
  hd = !hd;
  store.set("cutiecam-hd", hd);
  syncTopTools();
  toast(hd ? "HD on: after recording, the video is redrawn in high quality (takes a few minutes)."
           : "HD off: the video is saved right away with the live cartoon.", 3500);
};
setStyle(style);

/* ------------------------------------------------------------------ */
/* Background mode                                                     */
/* ------------------------------------------------------------------ */
function setMode(m) {
  mode = m;
  store.set("cutiecam-mode", m);
  $("modeRoom").setAttribute("aria-pressed", m === "room");
  $("modeScene").setAttribute("aria-pressed", m === "scene");
  $("styleRow").hidden = m === "scene";
  syncTopTools();
}
$("modeRoom").onclick = () => setMode("room");
$("modeScene").onclick = () => setMode("scene");
setMode(mode);

/* ------------------------------------------------------------------ */
/* Voice settings                                                      */
/* ------------------------------------------------------------------ */
let vset = store.get("cutiecam-voice", { preset: "cartoon", ...PRESETS.find((p) => p.id === "cartoon") });
const currentVoice = () => ({ pitch: vset.pitch, robot: vset.robot, echo: vset.echo, real: vset.real });
const sliders = {
  pitch: [$("sPitch"), $("oPitch"), (v) => (v > 0 ? "+" : "") + v, (v) => +v, (v) => v],
  robot: [$("sRobot"), $("oRobot"), (v) => v + "%", (v) => v / 100, (v) => Math.round(v * 100)],
  echo: [$("sEcho"), $("oEcho"), (v) => v + "%", (v) => v / 100, (v) => Math.round(v * 100)],
  real: [$("sReal"), $("oReal"), (v) => v + "%", (v) => v / 100, (v) => Math.round(v * 100)],
};
const presetsEl = $("presets");
for (const p of PRESETS) {
  const b = document.createElement("button");
  b.className = "preset"; b.textContent = p.name; b.dataset.id = p.id;
  b.onclick = () => { vset = { preset: p.id, ...p }; syncVoiceUI(); };
  presetsEl.append(b);
}
function syncVoiceUI() {
  for (const [k, [input, out, fmt, , toUI]] of Object.entries(sliders)) {
    input.value = toUI(vset[k]);
    out.textContent = fmt(input.value);
  }
  for (const b of presetsEl.children) b.setAttribute("aria-pressed", b.dataset.id === vset.preset);
  const p = PRESETS.find((x) => x.id === vset.preset);
  $("voiceLabel").textContent = p ? p.name : "Custom";
  voice.apply(currentVoice());
  store.set("cutiecam-voice", vset);
}
for (const [k, [input, out, fmt, fromUI]] of Object.entries(sliders)) {
  input.oninput = () => { vset[k] = fromUI(input.value); vset.preset = "custom"; out.textContent = fmt(input.value); syncVoiceUI(); };
}
syncVoiceUI();

$("voiceBtn").onclick = () => { voice.resume(); $("sheet").hidden = false; };
$("sheetClose").onclick = () => { $("sheet").hidden = true; };
$("monitor").onchange = (e) => { voice.resume(); voice.setMonitor(e.target.checked); };
$("testBtn").onclick = async () => {
  if (!voice.ready) return toast("Microphone is off. Allow it in phone Settings.");
  const b = $("testBtn");
  b.disabled = true;
  await voice.test(4, (s) => {
    b.textContent = s === "listening" ? "Say something…" : s === "playing" ? "Playing back…" : "Test voice (4 sec)";
  });
  b.disabled = false;
};

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.hidden = true), ms);
}
const stamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
function blobToB64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
async function saveToGallery(blob, name, mime) {
  if (!native) { // browser fallback (testing on a computer)
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    return "download";
  }
  const ok = native.begin(name, mime);
  if (ok !== "ok") throw new Error(ok);
  const CH = 1536 * 1024;
  for (let i = 0; i < blob.size; i += CH) {
    if (!native.append(await blobToB64(blob.slice(i, i + CH)))) throw new Error("write failed");
  }
  const uri = native.finish();
  if (!uri) throw new Error("finish failed");
  return uri;
}

let pending = null; // { blob, name, mime, uri }
function showPreview(blob, name, mime, note) {
  pending = { blob, name, mime, uri: null };
  const box = $("previewMedia");
  box.innerHTML = "";
  const url = URL.createObjectURL(blob);
  let el;
  if (mime.startsWith("video")) {
    el = document.createElement("video");
    el.src = url; el.controls = true; el.playsInline = true; el.autoplay = true; el.loop = true;
  } else {
    el = document.createElement("img"); el.src = url; el.alt = "Your photo";
  }
  el.className = "media";
  box.append(el);
  $("saveBtn").disabled = false;
  $("saveBtn").textContent = "Save to Gallery";
  $("previewHint").textContent = note || "";
  $("shareBtn").hidden = !native;
  $("preview").hidden = false;
}
function closePreview() {
  $("preview").hidden = true;
  const m = $("previewMedia").querySelector("video");
  if (m) m.pause();
  $("previewMedia").innerHTML = "";
  pending = null;
}
async function ensureSaved() {
  if (!pending) return null;
  if (pending.uri) return pending.uri;
  const b = $("saveBtn");
  b.disabled = true; b.textContent = "Saving…";
  try {
    pending.uri = await saveToGallery(pending.blob, pending.name, pending.mime);
    b.textContent = "Saved ✓";
    toast(pending.mime.startsWith("video") ? "Saved to Gallery › Movies › CutieCam" : "Saved to Gallery › Pictures › CutieCam");
    return pending.uri;
  } catch (e) {
    b.disabled = false; b.textContent = "Save to Gallery";
    toast("Couldn't save: " + e.message);
    return null;
  }
}
$("saveBtn").onclick = ensureSaved;
$("shareBtn").onclick = async () => {
  const uri = await ensureSaved();
  if (uri && native) native.share(uri, pending.mime);
};
$("closeBtn").onclick = closePreview;

$("photoBtn").onclick = () => {
  canvas.toBlob((b) => b && showPreview(b, `CutieCam_${stamp()}.jpg`, "image/jpeg"), "image/jpeg", 0.92);
};

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */
const recBtn = $("recBtn");
let recorder = null, chunks = [], recStart = 0, timerEl = null, timerInt = null, recMime = "";
function pickMime() {
  const list = [
    "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return list.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || "";
}
function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return "";
  if (sec < 60) return `${Math.max(1, Math.round(sec))} sec`;
  return `${Math.round(sec / 60)} min`;
}

recBtn.onclick = () => {
  if (converting || replaying) return;
  if (recording) { recorder && recorder.stop(); return; }
  if (!canvas.captureStream || !window.MediaRecorder) return toast("Recording isn't supported on this phone's WebView.");
  voice.resume();
  recMime = pickMime();
  const wantHD = style === "ai" && hd && mode === "room" && facing === "user";
  const useHD = wantHD && ai.ready && !!landmarker && hdSupported() && recMime.startsWith("video/mp4");
  if (wantHD && !useHD) {
    toast(!ai.ready ? "AI is still loading, so this clip uses the live cartoon." : "HD isn't supported on this phone, so this clip uses the live cartoon.", 3500);
  }
  // HD: record the plain camera (kept only in memory) and redraw it after; otherwise record what's on screen
  const tracks = [...(useHD ? rawCanvas : canvas).captureStream(30).getVideoTracks()];
  const a = voice.track || (micStream && micStream.getAudioTracks()[0]);
  if (a) tracks.push(a);
  try {
    recorder = new MediaRecorder(new MediaStream(tracks), recMime ? { mimeType: recMime, videoBitsPerSecond: useHD ? 8_000_000 : 6_000_000, audioBitsPerSecond: 128_000 } : undefined);
  } catch (e) {
    recorder = new MediaRecorder(new MediaStream(tracks));
  }
  chunks = [];
  recorder.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    recording = false;
    recBtn.classList.remove("on");
    recBtn.setAttribute("aria-label", "Start recording");
    clearInterval(timerInt);
    timerEl && timerEl.remove();
    const seconds = (performance.now() - recStart) / 1000;
    const mime = (recorder.mimeType || recMime || "video/webm").split(";")[0];
    const blob = new Blob(chunks, { type: mime });
    chunks = [];
    if (useHD) { startHD(blob, seconds); return; }
    const isMp4 = mime.includes("mp4");
    showPreview(blob, `CutieCam_${stamp()}.${isMp4 ? "mp4" : "webm"}`, mime,
      isMp4 ? "" : "This phone saved a WebM video, which Instagram may not accept. Update “Android System WebView” in the Play Store to get MP4.");
  };
  recorder.start(1000);
  recording = true;
  recStart = performance.now();
  recBtn.classList.add("on");
  recBtn.setAttribute("aria-label", "Stop recording");
  timerEl = document.createElement("span");
  timerEl.className = "timer";
  timerEl.textContent = "0:00";
  recBtn.append(timerEl);
  timerInt = setInterval(() => {
    const sec = Math.floor((performance.now() - recStart) / 1000);
    timerEl.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}${useHD ? " · HD" : ""}`;
  }, 250);
};

/* ------------------------------------------------------------------ */
/* HD conversion after recording                                       */
/* ------------------------------------------------------------------ */
let convertAbort = null;
function convUI(frac, text) {
  $("convBar").style.width = `${Math.round(frac * 100)}%`;
  $("convText").textContent = text;
}
async function startHD(raw, seconds) {
  converting = true;
  $("convert").hidden = false;
  $("convTitle").textContent = "Making your HD cartoon video";
  convUI(0, "Getting ready…");
  convertAbort = new AbortController();
  const signal = convertAbort.signal;
  try {
    await loadHDLibs();
    const plan = window.__cutiePlan || planHD(ai, Math.max(1, Math.round(seconds * 30))); // __cutiePlan: test hook
    convUI(0, `About ${fmtTime(plan.estSec)} for this ${fmtTime(seconds)} clip`);
    const t0 = performance.now();
    const out = await convertHD(raw, { W, H, landmarker, nextTs, ai, toon, skin: skinLook }, {
      res: plan.res, every: plan.every, signal,
      onProgress: (f, eta) => convUI(f, `${Math.round(f * 100)}%${eta != null ? ` · about ${fmtTime(eta)} left` : ""}`),
    });
    raw = null; // drop the plain clip
    console.log(`HD done in ${((performance.now() - t0) / 1000).toFixed(1)} s at ${plan.res}px, AI every ${plan.every} frame(s)`);
    $("convert").hidden = true;
    converting = false;
    showPreview(out, `CutieCam_${stamp()}.mp4`, "video/mp4");
  } catch (e) {
    converting = false;
    if (e && e.name === "AbortError") {
      raw = null;
      $("convert").hidden = true;
      toast("Cancelled. The clip was deleted.");
    } else {
      console.error("HD conversion failed", e);
      // fall back to redrawing the clip with the live cartoon, in real time
      try {
        $("convTitle").textContent = "Finishing your cartoon video";
        convUI(0, "HD didn't work on this phone, using the live cartoon instead…");
        const out = await replayConvert(raw, (f) => convUI(f, `${Math.round(f * 100)}%`));
        raw = null;
        $("convert").hidden = true;
        showPreview(out.blob, `CutieCam_${stamp()}.${out.mime.includes("mp4") ? "mp4" : "webm"}`, out.mime);
      } catch (e2) {
        console.error(e2);
        raw = null;
        $("convert").hidden = true;
        toast("Sorry, this clip couldn't be converted. Try again with HD off.", 4500);
      }
    }
  } finally {
    convertAbort = null;
    lastVideoTime = -1;
  }
}
$("convCancel").onclick = () => {
  if (convertAbort) convertAbort.abort();
  if (replayVideo) replayVideo.dispatchEvent(new Event("cutie-cancel"));
};

// Plays the plain clip through the live pipeline and records the result (takes as long as the clip).
let replayVideo = null;
function replayConvert(raw, onProgress) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    replayVideo = v;
    v.playsInline = true;
    v.preload = "auto";
    const url = URL.createObjectURL(raw);
    v.src = url;
    let rec = null, parts = [], audioCtx = null, finished = false;
    const done = (err, val) => {
      if (finished) return;
      finished = true;
      replaying = false; src = video; srcMirror = true; seenOnce = false; lastVideoTime = -1; replayVideo = null;
      try { v.pause(); } catch (_) {}
      URL.revokeObjectURL(url);
      if (audioCtx && audioCtx !== voice.ctx) audioCtx.close().catch(() => {});
      err ? reject(err) : resolve(val);
    };
    v.addEventListener("cutie-cancel", () => {
      done(new DOMException("Cancelled", "AbortError")); // marks finished first, so onstop below is ignored
      if (rec && rec.state !== "inactive") rec.stop();
    });
    v.onerror = () => done(new Error("Couldn't play the clip"));
    v.onloadedmetadata = async () => {
      try {
        const tracks = [...canvas.captureStream(30).getVideoTracks()];
        audioCtx = voice.ctx || new AudioContext();
        const node = audioCtx.createMediaElementSource(v);
        const dest = audioCtx.createMediaStreamDestination();
        node.connect(dest);
        const at = dest.stream.getAudioTracks()[0];
        if (at) tracks.push(at);
        const mime = pickMime();
        rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
        rec.ondataavailable = (e) => e.data && e.data.size && parts.push(e.data);
        rec.onstop = () => {
          if (finished) return;
          const m = (rec.mimeType || mime || "video/webm").split(";")[0];
          done(null, { blob: new Blob(parts, { type: m }), mime: m });
        };
        src = v; srcMirror = false; replaying = true; seenOnce = false; lastVideoTime = -1;
        v.ontimeupdate = () => onProgress && v.duration && isFinite(v.duration) && onProgress(Math.min(0.99, v.currentTime / v.duration));
        v.onended = () => rec.state !== "inactive" && rec.stop();
        rec.start(1000);
        await v.play();
      } catch (e) { done(e); }
    };
  });
}

/* Android back button: close panels first */
window.cutieBack = () => {
  if (converting || replaying) return true; // ignore back while converting (use Cancel)
  if (!$("preview").hidden) { closePreview(); return true; }
  if (!$("sheet").hidden) { $("sheet").hidden = true; return true; }
  if (recording) { recorder.stop(); return true; }
  return false;
};

document.addEventListener("visibilitychange", () => {
  if (document.hidden && recording) recorder.stop();
});
