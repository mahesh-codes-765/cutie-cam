// Chibi girl character, drawn with Canvas 2D.
// State `s`: x, y (head centre), R (head radius), roll, yaw, pitch,
// bL, bR (blink 0..1), jaw (mouth open 0..1), smile, brow, pucker.

export const LOOK = {
  skin: "#f7d2b2",
  skinShade: "#ecb592",
  hair: "#3b2423",
  hairHi: "#6e4642",
  line: "#3a2026",
  irisTop: "#2c1418",
  irisLow: "#b9733f",
  bow: "#ff6f96",
  bowDark: "#d9466f",
  top: "#b7a1ff",
  topDark: "#8f74ea",
  blush: "255,118,148",
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function ell(ctx, x, y, rx, ry, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, Math.PI * 2);
}

/* ---------- hair physics: a soft spring that lags behind head movement ---------- */
export function makeHair() {
  return { ang: 0, v: 0, lastX: null };
}
export function updateHair(h, s, dt) {
  if (h.lastX == null) { h.lastX = s.x; h.ang = s.roll; }
  const dx = (s.x - h.lastX) / Math.max(1, s.R);
  h.lastX = s.x;
  h.v += (s.roll - h.ang) * 0.1 * dt - h.v * 0.16 * dt - dx * 0.22;
  h.ang += h.v * dt;
  h.ang = clamp(h.ang, s.roll - 0.45, s.roll + 0.45);
}

/* ---------- parts ---------- */
function backHair(ctx, R, L) {
  ctx.beginPath();
  ctx.moveTo(-1.0 * R, -0.15 * R);
  ctx.bezierCurveTo(-1.14 * R, -1.28 * R, 1.14 * R, -1.28 * R, 1.0 * R, -0.15 * R);
  ctx.bezierCurveTo(1.12 * R, 0.55 * R, 1.16 * R, 1.15 * R, 1.0 * R, 1.62 * R);
  // wavy ends
  ctx.quadraticCurveTo(0.82 * R, 1.5 * R, 0.66 * R, 1.66 * R);
  ctx.quadraticCurveTo(0.5 * R, 1.48 * R, 0.3 * R, 1.6 * R);
  ctx.lineTo(-0.3 * R, 1.6 * R);
  ctx.quadraticCurveTo(-0.5 * R, 1.48 * R, -0.66 * R, 1.66 * R);
  ctx.quadraticCurveTo(-0.82 * R, 1.5 * R, -1.0 * R, 1.62 * R);
  ctx.bezierCurveTo(-1.16 * R, 1.15 * R, -1.12 * R, 0.55 * R, -1.0 * R, -0.15 * R);
  ctx.closePath();
  ctx.fillStyle = L.hair;
  ctx.fill();
  ctx.stroke();
}

function face(ctx, R, L) {
  ctx.beginPath();
  ctx.moveTo(-0.86 * R, -0.1 * R);
  ctx.bezierCurveTo(-0.9 * R, -1.0 * R, 0.9 * R, -1.0 * R, 0.86 * R, -0.1 * R);
  ctx.bezierCurveTo(0.85 * R, 0.5 * R, 0.42 * R, 0.84 * R, 0, 0.86 * R);
  ctx.bezierCurveTo(-0.42 * R, 0.84 * R, -0.85 * R, 0.5 * R, -0.86 * R, -0.1 * R);
  ctx.closePath();
  ctx.fillStyle = L.skin;
  ctx.fill();
  ctx.stroke();
}

function eye(ctx, L, x, y, R, side, blink, smile, brow) {
  const w = 0.19 * R;
  const h = 0.25 * R * (1 + brow * 0.12);
  const lw = 0.05 * R;

  // eyebrow
  ctx.save();
  ctx.strokeStyle = L.hair;
  ctx.lineWidth = 0.032 * R;
  const by = y - 0.36 * R - brow * 0.09 * R;
  ctx.beginPath();
  ctx.moveTo(x - side * 0.1 * R, by + 0.02 * R);
  ctx.quadraticCurveTo(x + side * 0.02 * R, by - 0.035 * R, x + side * 0.13 * R, by + 0.01 * R);
  ctx.stroke();
  ctx.restore();

  if (blink > 0.55) {
    ctx.save();
    ctx.lineWidth = lw;
    ctx.beginPath();
    if (smile > 0.4) { // happy ^ ^
      ctx.moveTo(x - w, y + 0.04 * R);
      ctx.quadraticCurveTo(x, y - 0.14 * R, x + w, y + 0.04 * R);
    } else { // relaxed closed lid with lash
      ctx.moveTo(x - w, y);
      ctx.quadraticCurveTo(x, y + 0.1 * R, x + w, y);
      ctx.moveTo(x + side * w * 0.95, y + 0.01 * R);
      ctx.lineTo(x + side * w * 1.25, y - 0.05 * R);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }

  const open = clamp(1 - blink * 1.35, 0.15, 1);
  const eh = h * open;
  const ey = y + (h - eh) * 0.5; // lid closes from the top

  ctx.save();
  // white
  ell(ctx, x, ey, w * 1.02, eh);
  ctx.fillStyle = "#fffaf6";
  ctx.fill();
  ctx.save();
  ell(ctx, x, ey, w * 1.02, eh);
  ctx.clip();
  // iris with warm gradient
  const g = ctx.createLinearGradient(0, ey - eh, 0, ey + eh);
  g.addColorStop(0, L.irisTop);
  g.addColorStop(0.55, "#6b3a22");
  g.addColorStop(1, L.irisLow);
  ell(ctx, x + side * 0.01 * R, ey + eh * 0.06, w * 0.84, eh * 0.98);
  ctx.fillStyle = g;
  ctx.fill();
  ell(ctx, x + side * 0.01 * R, ey + eh * 0.1, w * 0.38, eh * 0.46);
  ctx.fillStyle = "#1f0f12";
  ctx.fill();
  if (open > 0.35) {
    ell(ctx, x - w * 0.3, ey - eh * 0.36, w * 0.24, w * 0.24);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ell(ctx, x + w * 0.28, ey + eh * 0.32, w * 0.1, w * 0.1);
    ctx.fill();
  }
  ctx.restore();

  // upper lash line + wing
  ctx.lineWidth = lw * 1.25;
  ctx.beginPath();
  ctx.ellipse(x, ey, w * 1.08, eh * 1.02, 0, Math.PI + 0.25, Math.PI * 2 - 0.25);
  ctx.stroke();
  ctx.lineWidth = lw;
  ctx.beginPath();
  const cx = x + side * w * 1.02;
  const cy = ey - eh * 0.42;
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + side * w * 0.32, cy - eh * 0.28);
  ctx.stroke();
  // soft lower lash
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = lw * 0.5;
  ctx.beginPath();
  ctx.ellipse(x, ey, w * 0.9, eh * 1.0, 0, 0.5, Math.PI - 0.5);
  ctx.stroke();
  ctx.restore();
}

function mouth(ctx, L, mx, my, R, s) {
  const open = clamp((s.jaw - 0.05) / 0.4, 0, 1);
  ctx.save();
  ctx.lineWidth = 0.035 * R;
  if (open < 0.08) {
    if (s.pucker > 0.45) {
      ell(ctx, mx, my + 0.02 * R, 0.045 * R, 0.055 * R);
      ctx.fillStyle = "#d4506e";
      ctx.fill();
      ctx.stroke();
    } else {
      const w = 0.09 * R * (1 + s.smile * 0.7);
      ctx.beginPath();
      ctx.moveTo(mx - w, my);
      ctx.quadraticCurveTo(mx, my + 0.035 * R + s.smile * 0.08 * R, mx + w, my);
      ctx.stroke();
    }
  } else {
    const w = 0.1 * R * (1 + s.smile * 0.35) + 0.02 * R;
    const h = 0.05 * R + 0.22 * R * open;
    const p = new Path2D();
    p.moveTo(mx - w, my);
    p.quadraticCurveTo(mx, my - h * 0.1 + s.smile * h * 0.12, mx + w, my);
    p.bezierCurveTo(mx + w * 1.02, my + h * 1.3, mx - w * 1.02, my + h * 1.3, mx - w, my);
    p.closePath();
    ctx.fillStyle = "#7a2438";
    ctx.fill(p);
    ctx.save();
    ctx.clip(p);
    ell(ctx, mx, my + h * 1.02, w * 0.62, h * 0.45);
    ctx.fillStyle = "#ff8fa8";
    ctx.fill();
    ctx.restore();
    ctx.stroke(p);
  }
  ctx.restore();
}

function bangs(ctx, R, L) {
  ctx.beginPath();
  ctx.moveTo(-0.99 * R, 0.12 * R);
  ctx.bezierCurveTo(-1.1 * R, -1.12 * R, 1.1 * R, -1.12 * R, 0.99 * R, 0.12 * R);
  ctx.quadraticCurveTo(0.88 * R, -0.3 * R, 0.72 * R, -0.44 * R);
  ctx.quadraticCurveTo(0.62 * R, -0.13 * R, 0.45 * R, -0.13 * R);
  ctx.quadraticCurveTo(0.38 * R, -0.37 * R, 0.22 * R, -0.42 * R);
  ctx.quadraticCurveTo(0.15 * R, -0.12 * R, -0.02 * R, -0.16 * R);
  ctx.quadraticCurveTo(-0.08 * R, -0.39 * R, -0.24 * R, -0.43 * R);
  ctx.quadraticCurveTo(-0.33 * R, -0.12 * R, -0.49 * R, -0.13 * R);
  ctx.quadraticCurveTo(-0.6 * R, -0.37 * R, -0.73 * R, -0.43 * R);
  ctx.quadraticCurveTo(-0.88 * R, -0.3 * R, -0.99 * R, 0.12 * R);
  ctx.closePath();
  ctx.fillStyle = L.hair;
  ctx.fill();
  ctx.stroke();
  // shine
  ctx.save();
  ctx.strokeStyle = L.hairHi;
  ctx.lineWidth = 0.05 * R;
  ctx.beginPath();
  ctx.arc(0, -0.05 * R, 0.74 * R, Math.PI * 1.18, Math.PI * 1.36);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -0.05 * R, 0.74 * R, Math.PI * 1.46, Math.PI * 1.56);
  ctx.stroke();
  ctx.restore();
}

function sideLock(ctx, R, L, side, sway) {
  const tipX = side * 0.8 * R + sway * R * 0.5;
  ctx.beginPath();
  ctx.moveTo(side * 0.97 * R, -0.25 * R);
  ctx.quadraticCurveTo(side * 0.98 * R, 0.4 * R, tipX, 0.86 * R);
  ctx.quadraticCurveTo(side * 0.7 * R, 0.4 * R, side * 0.72 * R, -0.2 * R);
  ctx.closePath();
  ctx.fillStyle = L.hair;
  ctx.fill();
  ctx.stroke();
}

function bow(ctx, R, L) {
  ctx.save();
  ctx.translate(0.56 * R, -0.84 * R);
  ctx.rotate(0.4);
  for (const sd of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(sd * 0.18 * R, -0.22 * R, sd * 0.36 * R, -0.12 * R, sd * 0.34 * R, 0.02 * R);
    ctx.bezierCurveTo(sd * 0.33 * R, 0.17 * R, sd * 0.16 * R, 0.16 * R, 0, 0);
    ctx.closePath();
    ctx.fillStyle = L.bow;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sd * 0.07 * R, -0.01 * R);
    ctx.quadraticCurveTo(sd * 0.17 * R, -0.04 * R, sd * 0.24 * R, 0.0);
    ctx.save();
    ctx.strokeStyle = L.bowDark;
    ctx.lineWidth = 0.025 * R;
    ctx.stroke();
    ctx.restore();
  }
  ell(ctx, 0, 0, 0.075 * R, 0.07 * R);
  ctx.fillStyle = L.bowDark;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function body(ctx, s, L) {
  const R = s.R, x = s.x, y = s.y;
  ctx.save();
  // neck
  ctx.beginPath();
  ctx.rect(x - 0.16 * R, y + 0.6 * R, 0.32 * R, 0.62 * R);
  ctx.fillStyle = L.skinShade;
  ctx.fill();
  // top
  ctx.beginPath();
  ctx.moveTo(x - 1.4 * R, y + 3.4 * R);
  ctx.bezierCurveTo(x - 1.35 * R, y + 1.8 * R, x - 1.1 * R, y + 1.3 * R, x - 0.42 * R, y + 1.15 * R);
  ctx.quadraticCurveTo(x, y + 1.5 * R, x + 0.42 * R, y + 1.15 * R);
  ctx.bezierCurveTo(x + 1.1 * R, y + 1.3 * R, x + 1.35 * R, y + 1.8 * R, x + 1.4 * R, y + 3.4 * R);
  ctx.closePath();
  ctx.fillStyle = L.top;
  ctx.fill();
  ctx.stroke();
  // collar
  ctx.beginPath();
  ctx.moveTo(x - 0.42 * R, y + 1.15 * R);
  ctx.quadraticCurveTo(x, y + 1.5 * R, x + 0.42 * R, y + 1.15 * R);
  ctx.strokeStyle = L.topDark;
  ctx.lineWidth = 0.06 * R;
  ctx.stroke();
  // little heart on the shirt
  ctx.translate(x + 0.55 * R, y + 1.95 * R);
  const k = 0.13 * R;
  ctx.beginPath();
  ctx.moveTo(0, k * 0.35);
  ctx.bezierCurveTo(k * 0.9, -k * 0.25, k * 0.45, -k * 0.95, 0, -k * 0.45);
  ctx.bezierCurveTo(-k * 0.45, -k * 0.95, -k * 0.9, -k * 0.25, 0, k * 0.35);
  ctx.fillStyle = L.bow;
  ctx.fill();
  ctx.restore();
}

/* ---------- main draw ---------- */
export function drawGirl(ctx, s, hair, opts = {}) {
  const L = LOOK, R = s.R;
  const fx = s.yaw * R * 0.55;
  const fy = s.pitch * R * 0.45;
  const sway = hair ? clamp(hair.ang - s.roll, -0.45, 0.45) : 0;

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = L.line;
  ctx.lineWidth = Math.max(2, R * 0.04);

  // back hair, swinging from the crown
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.roll);
  ctx.translate(0, -0.3 * R);
  ctx.rotate(sway * 0.6);
  ctx.translate(0, 0.3 * R);
  backHair(ctx, R, L);
  ctx.restore();

  if (opts.body) body(ctx, s, L);

  ctx.translate(s.x, s.y);
  ctx.rotate(s.roll);
  ctx.lineWidth = Math.max(2, R * 0.04);
  ctx.strokeStyle = L.line;

  face(ctx, R, L);

  // blush
  for (const sd of [-1, 1]) {
    ell(ctx, sd * 0.5 * R + fx * 0.8, 0.4 * R + fy, 0.13 * R, 0.075 * R);
    ctx.fillStyle = `rgba(${L.blush},${0.3 + s.smile * 0.45})`;
    ctx.fill();
  }

  // eyes
  for (const sd of [-1, 1]) {
    const b = sd < 0 ? s.bL : s.bR;
    eye(ctx, L, sd * 0.35 * R + fx, 0.12 * R + fy, R, sd, b, s.smile, s.brow);
  }

  // nose
  ctx.save();
  ctx.lineWidth = 0.025 * R;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(fx - 0.015 * R, 0.37 * R + fy);
  ctx.lineTo(fx + 0.015 * R, 0.39 * R + fy);
  ctx.stroke();
  ctx.restore();

  mouth(ctx, L, fx, 0.53 * R + fy, R, s);

  // front hair moves a little less than the face for depth
  ctx.save();
  ctx.translate(fx * 0.3, fy * 0.15);
  sideLock(ctx, R, L, -1, sway);
  sideLock(ctx, R, L, 1, sway);
  bangs(ctx, R, L);
  bow(ctx, R, L);
  ctx.restore();

  ctx.restore();
}

export const neutralState = (x, y, R) => ({
  x, y, R, roll: 0, yaw: 0, pitch: 0, bL: 0, bR: 0, jaw: 0, smile: 0.35, brow: 0, pucker: 0,
});
