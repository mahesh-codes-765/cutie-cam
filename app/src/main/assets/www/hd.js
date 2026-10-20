// HD conversion after recording.
// The raw clip (kept only in memory, never saved) is demuxed with mp4box.js, each frame is
// decoded with WebCodecs, cartoonized, re-encoded to H.264 and muxed into a new MP4 with the
// original (already voice-changed) audio copied across unchanged. The raw clip is then dropped.

/* global MP4Box, DataStream, Mp4Muxer */
import { AICartoon, headPose } from "./aicartoon.js";
import { drawToonFace, makeToonState } from "./toonface.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return res();
    const s = document.createElement("script");
    s.src = src;
    s.dataset.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error("couldn't load " + src));
    document.head.append(s);
  });
}

export async function loadHDLibs() {
  await loadScript("lib/mp4box.all.min.js");
  await loadScript("lib/mp4-muxer.js");
}

export function hdSupported() {
  return typeof VideoDecoder !== "undefined" && typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

function demux(buf) {
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    const vs = [], as = [];
    let info = null;
    file.onError = (e) => reject(new Error("Couldn't read the recording (" + e + ")"));
    file.onReady = (i) => {
      info = i;
      const v = i.videoTracks[0], a = i.audioTracks[0];
      if (!v) return reject(new Error("The recording has no video"));
      file.setExtractionOptions(v.id, "v", { nbSamples: 1e9 });
      if (a) file.setExtractionOptions(a.id, "a", { nbSamples: 1e9 });
      file.start();
    };
    file.onSamples = (id, user, samples) => { (user === "v" ? vs : as).push(...samples); };
    buf.fileStart = 0;
    file.appendBuffer(buf);
    file.flush();
    setTimeout(() => {
      if (!info) return reject(new Error("Couldn't read the recording"));
      resolve({ file, info, vs, as });
    }, 0);
  });
}

function boxBytes(box) {
  const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
  box.write(s);
  return new Uint8Array(s.buffer, 8); // drop the box header
}

function videoDescription(file, track) {
  const trak = file.getTrackById(track.id);
  for (const e of trak.mdia.minf.stbl.stsd.entries) {
    const box = e.avcC || e.hvcC || e.vpcC || e.av1C;
    if (box) return boxBytes(box);
  }
  return undefined;
}

function audioConfig(file, track) {
  const trak = file.getTrackById(track.id);
  const e = trak.mdia.minf.stbl.stsd.entries[0];
  let description;
  try {
    if (e.esds) description = e.esds.esd.descs[0].descs[0].data;
    else if (e.dOps) description = boxBytes(e.dOps);
  } catch (_) { description = undefined; }
  const codec = track.codec.toLowerCase().startsWith("mp4a") ? "aac" : track.codec.toLowerCase().includes("opus") ? "opus" : null;
  return {
    muxCodec: codec,
    decoderConfig: {
      codec: track.codec,
      numberOfChannels: track.audio.channel_count,
      sampleRate: track.audio.sample_rate,
      ...(description ? { description } : {}),
    },
  };
}

async function pickEncoder(width, height) {
  for (const codec of ["avc1.640028", "avc1.4D0028", "avc1.42E028", "avc1.42E01F", "avc1.42001F"]) {
    const cfg = { codec, width, height, bitrate: 7_000_000, framerate: 30, avc: { format: "avc" } };
    try {
      const s = await VideoEncoder.isConfigSupported(cfg);
      if (s.supported) return cfg;
    } catch (_) { /* try next */ }
  }
  throw new Error("This phone can't encode H.264 video");
}

/** Pick crop resolution and how often to run the AI, from the live speed measurement. */
export function planHD(ai, frames) {
  const per = (res) => (ai.avgMs || 300) * (res / (ai.res || 160)) ** 2;
  const options = [[384, 1], [320, 1], [256, 1], [320, 2], [256, 2], [224, 2], [192, 3]];
  let pick = options[options.length - 1];
  for (const [res, every] of options) {
    if (per(res) / every + 45 <= 420) { pick = [res, every]; break; }
  }
  const [res, every] = pick;
  const estSec = (frames * (per(res) / every + 45)) / 1000;
  return { res, every, estSec };
}

/**
 * deps: { W, H, landmarker, nextTs(), ai (AICartoon, ready) or null, toon (ToonFilter), skin() -> look }
 * opts: { res, every, onProgress(fraction, etaSec), signal }
 */
export async function convertHD(blob, deps, opts) {
  const { W, H } = deps;
  const buf = await blob.arrayBuffer();
  const { file, info, vs, as } = await demux(buf);
  const vTrack = info.videoTracks[0];
  const aTrack = info.audioTracks[0];

  const encCfg = await pickEncoder(W, H);
  const target = new Mp4Muxer.ArrayBufferTarget();
  let aCfg = aTrack ? audioConfig(file, aTrack) : null;
  if (aCfg && !aCfg.muxCodec) aCfg = null; // unknown audio codec: keep video only
  const muxer = new Mp4Muxer.Muxer({
    target,
    video: { codec: "avc", width: W, height: H, frameRate: 30 },
    ...(aCfg ? { audio: { codec: aCfg.muxCodec, numberOfChannels: aCfg.decoderConfig.numberOfChannels, sampleRate: aCfg.decoderConfig.sampleRate } } : {}),
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  encoder.configure(encCfg);

  // audio: copy the encoded samples across unchanged
  if (aCfg) {
    as.forEach((s, i) => {
      const ts = (s.cts * 1e6) / s.timescale;
      const dur = (s.duration * 1e6) / s.timescale;
      muxer.addAudioChunkRaw(s.data, "key", ts, dur, i === 0 ? { decoderConfig: aCfg.decoderConfig } : undefined);
    });
  }

  // video decoding with back-pressure
  const frames = [];
  let wake = null, flushed = false, si = 0, flushing = false;
  const decoder = new VideoDecoder({
    output: (f) => { frames.push(f); if (wake) { wake(); wake = null; } },
    error: (e) => { failure = e; if (wake) { wake(); wake = null; } },
  });
  decoder.configure({
    codec: vTrack.codec,
    codedWidth: vTrack.video.width,
    codedHeight: vTrack.video.height,
    description: videoDescription(file, vTrack),
  });
  async function nextFrame() {
    for (;;) {
      if (failure) throw failure;
      if (frames.length) return frames.shift();
      while (si < vs.length && decoder.decodeQueueSize < 6) {
        const s = vs[si++];
        decoder.decode(new EncodedVideoChunk({
          type: s.is_sync ? "key" : "delta",
          timestamp: (s.cts * 1e6) / s.timescale,
          duration: (s.duration * 1e6) / s.timescale,
          data: s.data,
        }));
      }
      if (si >= vs.length && !flushing) {
        flushing = true;
        decoder.flush().then(() => { flushed = true; if (wake) { wake(); wake = null; } }).catch((e) => { failure = e; });
      }
      if (flushed && !frames.length) return null;
      await Promise.race([new Promise((r) => (wake = r)), sleep(40)]);
    }
  }

  const frameC = document.createElement("canvas");
  frameC.width = W; frameC.height = H;
  const fctx = frameC.getContext("2d");
  const outC = document.createElement("canvas");
  outC.width = W; outC.height = H;
  const octx = outC.getContext("2d");
  const small = document.createElement("canvas");
  const sctx = small.getContext("2d");
  const toonState = makeToonState();
  const ai = deps.ai && deps.ai.ready ? deps.ai : null;
  const every = Math.max(1, opts.every || 1);
  let pts = null, lastHead = null, n = 0;
  const total = vs.length;
  const t0 = performance.now();

  try {
    for (;;) {
      if (opts.signal && opts.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const f = await nextFrame();
      if (!f) break;
      const ts = f.timestamp, dur = f.duration;
      fctx.drawImage(f, 0, 0, W, H);
      f.close();

      // find the face in this frame
      let found = null;
      try {
        const r = deps.landmarker.detectForVideo(frameC, deps.nextTs());
        const lm = r.faceLandmarks && r.faceLandmarks[0];
        if (lm) found = lm.map((p) => ({ x: p.x * W, y: p.y * H }));
      } catch (_) { found = null; }
      if (found) {
        if (!pts) pts = found;
        else for (let i = 0; i < pts.length; i++) {
          pts[i].x += (found[i].x - pts[i].x) * 0.7;
          pts[i].y += (found[i].y - pts[i].y) * 0.7;
        }
      } else {
        pts = null;
      }

      if (pts) {
        // cartoon background, then the face
        if (deps.toon.render(frameC, { ox: 0, oy: 0, dw: W, dh: H }, W, H, false)) octx.drawImage(deps.toon.canvas, 0, 0, W, H);
        else octx.drawImage(frameC, 0, 0);
        const pose = headPose(pts);
        if (ai) {
          if (!lastHead || n % every === 0) {
            const crop = ai.cropHead(frameC, pose, opts.res);
            lastHead = await ai.paintCrop(crop);
          }
          AICartoon.place(octx, lastHead, pose);
        } else {
          drawToonFace(octx, pts, deps.skin(), 0.3, toonState);
        }
      } else {
        // no face in this frame: blur the whole frame so nothing slips through
        small.width = 16; small.height = Math.round((16 * H) / W);
        sctx.drawImage(frameC, 0, 0, small.width, small.height);
        octx.imageSmoothingEnabled = true;
        octx.drawImage(small, 0, 0, W, H);
        octx.fillStyle = "rgba(29,22,38,.35)";
        octx.fillRect(0, 0, W, H);
      }

      while (encoder.encodeQueueSize > 4) await sleep(5);
      if (failure) throw failure;
      const vf = new VideoFrame(outC, { timestamp: ts, duration: dur || undefined });
      encoder.encode(vf, { keyFrame: n % 60 === 0 });
      vf.close();
      n++;
      if (opts.onProgress) {
        const el = (performance.now() - t0) / 1000;
        const frac = Math.min(0.99, n / total);
        opts.onProgress(frac, n > 3 ? (el / n) * (total - n) : null);
      }
    }
    await encoder.flush();
    if (failure) throw failure;
    muxer.finalize();
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally {
    try { decoder.close(); } catch (_) {}
    try { encoder.close(); } catch (_) {}
    for (const f of frames) try { f.close(); } catch (_) {}
  }
}
