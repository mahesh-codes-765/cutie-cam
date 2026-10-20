// "Toon face": paints a cartoon face directly onto her real face shape, using the
// 478 MediaPipe face-mesh points (already mapped into canvas pixels).
// Eyes sit on her eyes, the mouth follows her lips, brows follow her brows.

const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const EYES = [
  { outer: 33, inner: 133, top: 159, bottom: 145, iris: 468, brow: [70, 63, 105, 66, 107], key: "r" },
  { outer: 263, inner: 362, top: 386, bottom: 374, iris: 473, brow: [300, 293, 334, 296, 336], key: "l" },
];
const LIP_TOP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308];
const LIP_BOT = [308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78];

const INK = "#2e1c22";
const BROW = "#3b2423";
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function makeToonState() {
  return { base: { r: 0.3, l: 0.3 } };
}

function smoothClosed(ctx, pts) {
  ctx.beginPath();
  const n = pts.length;
  const m0 = mid(pts[n - 1], pts[0]);
  ctx.moveTo(m0.x, m0.y);
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n], m = mid(p, q);
    ctx.quadraticCurveTo(p.x, p.y, m.x, m.y);
  }
  ctx.closePath();
}

function smoothOpen(ctx, pts) {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const m = mid(pts[i], pts[i + 1]);
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
}

function animeEye(ctx, rx, ry, open, side, gx, gy, smile) {
  const lw = Math.max(1.5, rx * 0.16);
  ctx.strokeStyle = INK;
  if (open < 0.28) {
    ctx.lineWidth = lw;
    ctx.beginPath();
    if (smile > 0.4) {
      ctx.moveTo(-rx, ry * 0.1);
      ctx.quadraticCurveTo(0, -ry * 0.55, rx, ry * 0.1);
    } else {
      ctx.moveTo(-rx, 0);
      ctx.quadraticCurveTo(0, ry * 0.4, rx, 0);
      ctx.moveTo(side * rx * 0.95, 0);
      ctx.lineTo(side * rx * 1.3, -ry * 0.2);
    }
    ctx.stroke();
    return;
  }
  const eh = ry * clamp(open, 0.3, 1);
  const ey = ry - eh; // lid closes from the top

  ctx.beginPath();
  ctx.ellipse(0, ey, rx, eh, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#fffaf6";
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, ey, rx, eh, 0, 0, Math.PI * 2);
  ctx.clip();
  const ix = gx * rx * 1.2, iy = ey + gy * ry * 0.8 + eh * 0.06;
  const g = ctx.createLinearGradient(0, iy - ry, 0, iy + ry);
  g.addColorStop(0, "#2c1418");
  g.addColorStop(0.55, "#6b3a22");
  g.addColorStop(1, "#c07d47");
  ctx.beginPath();
  ctx.ellipse(ix, iy, rx * 0.8, ry * 0.95, 0, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(ix, iy + ry * 0.05, rx * 0.36, ry * 0.44, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#1f0f12";
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(ix - rx * 0.3, iy - ry * 0.36, rx * 0.24, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ix + rx * 0.28, iy + ry * 0.3, rx * 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // lash line + wing
  ctx.lineWidth = lw * 1.3;
  ctx.beginPath();
  ctx.ellipse(0, ey, rx * 1.06, eh * 1.02, 0, Math.PI + 0.22, Math.PI * 2 - 0.22);
  ctx.stroke();
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(side * rx, ey - eh * 0.4);
  ctx.lineTo(side * rx * 1.32, ey - eh * 0.72);
  ctx.moveTo(side * rx * 0.86, ey - eh * 0.62);
  ctx.lineTo(side * rx * 1.08, ey - eh * 0.98);
  ctx.stroke();
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = lw * 0.5;
  ctx.beginPath();
  ctx.ellipse(0, ey, rx * 0.9, eh, 0, 0.5, Math.PI - 0.5);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * pts: array of {x, y} in canvas pixels (all 478 face-mesh points, smoothed).
 * look: { skin, skinLight, skinShade } colours; smile 0..1.
 */
export function drawToonFace(ctx, pts, look, smile, state) {
  const P = (i) => pts[i];
  const faceW = dist(P(234), P(454));
  const faceH = dist(P(10), P(152));
  let c = { x: 0, y: 0 };
  for (const i of OVAL) { c.x += P(i).x; c.y += P(i).y; }
  c.x /= OVAL.length; c.y /= OVAL.length;

  // head tilt from the eye corners (kept within ±90°)
  let roll = Math.atan2(P(263).y - P(33).y, P(263).x - P(33).x);
  if (roll > Math.PI / 2) roll -= Math.PI;
  else if (roll < -Math.PI / 2) roll += Math.PI;
  const ux = Math.cos(roll), uy = Math.sin(roll); // across the face
  const dx = -uy, dy = ux;                        // down the face

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // soft shadow on the neck under the chin
  const chin = P(152);
  ctx.beginPath();
  ctx.ellipse(chin.x + dx * faceH * 0.05, chin.y + dy * faceH * 0.05, faceW * 0.3, faceH * 0.07, roll, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(40,20,30,.18)";
  ctx.fill();

  // face shape, slightly enlarged so no real skin shows at the edge
  const oval = OVAL.map((i) => {
    const p = P(i);
    const k = i === 152 || i === 148 || i === 377 ? 1.05 : 1.08;
    return { x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k };
  });
  const grad = ctx.createRadialGradient(c.x - dx * faceH * 0.12, c.y - dy * faceH * 0.12, faceW * 0.05, c.x, c.y, faceW * 0.72);
  grad.addColorStop(0, look.skinLight);
  grad.addColorStop(1, look.skin);
  smoothClosed(ctx, oval);
  ctx.fillStyle = grad;
  ctx.fill();

  // cel-shaded rim inside the edge
  ctx.save();
  smoothClosed(ctx, oval);
  ctx.clip();
  ctx.lineWidth = faceW * 0.08;
  ctx.strokeStyle = look.skinShade;
  ctx.globalAlpha = 0.38;
  smoothClosed(ctx, oval);
  ctx.stroke();
  ctx.restore();

  // ink outline
  ctx.lineWidth = Math.max(2, faceW * 0.02);
  ctx.strokeStyle = INK;
  smoothClosed(ctx, oval);
  ctx.stroke();

  // blush
  for (const i of [50, 280]) {
    const p = P(i);
    ctx.beginPath();
    ctx.ellipse(p.x + dx * faceH * 0.02, p.y + dy * faceH * 0.02, faceW * 0.11, faceW * 0.06, roll, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,112,145,${0.3 + smile * 0.3})`;
    ctx.fill();
  }

  // brows, nudged up so the big eyes have room
  for (const e of EYES) {
    const ew = dist(P(e.outer), P(e.inner));
    const pts2 = e.brow.map((i) => ({ x: P(i).x - dx * ew * 0.14, y: P(i).y - dy * ew * 0.14 }));
    ctx.beginPath();
    smoothOpen(ctx, pts2);
    ctx.strokeStyle = BROW;
    ctx.lineWidth = Math.max(2, ew * 0.1);
    ctx.stroke();
  }

  // eyes
  for (const e of EYES) {
    const o = P(e.outer), inn = P(e.inner);
    const ew = dist(o, inn);
    const ap = dist(P(e.top), P(e.bottom)) / Math.max(1, ew);
    const b = state.base[e.key];
    state.base[e.key] = Math.max(b * 0.997, ap, 0.18); // adaptive "fully open" level
    const open = clamp((ap / state.base[e.key] - 0.38) / 0.42, 0, 1);
    const ctr = mid(mid(o, inn), mid(P(e.top), P(e.bottom)));
    const side = Math.sign((o.x - inn.x) * ux + (o.y - inn.y) * uy) || 1;
    // gaze from the iris position inside the eye
    const ir = P(e.iris) || ctr;
    const rxv = ir.x - ctr.x, ryv = ir.y - ctr.y;
    const gx = clamp(((rxv * ux + ryv * uy) / ew) * 2.2, -0.3, 0.3);
    const gy = clamp(((rxv * dx + ryv * dy) / ew) * 2.2, -0.25, 0.25);
    ctx.save();
    ctx.translate(ctr.x + dx * ew * 0.06, ctr.y + dy * ew * 0.06);
    ctx.rotate(roll);
    animeEye(ctx, ew * 0.6, ew * 0.66, open, side, gx, gy, smile);
    ctx.restore();
  }

  // nose: a small curve under the tip
  const nb = P(2);
  ctx.beginPath();
  ctx.moveTo(nb.x - ux * faceW * 0.035, nb.y - uy * faceW * 0.035);
  ctx.quadraticCurveTo(nb.x + dx * faceW * 0.015, nb.y + dy * faceW * 0.015, nb.x + ux * faceW * 0.035, nb.y + uy * faceW * 0.035);
  ctx.strokeStyle = INK;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = Math.max(1.5, faceW * 0.014);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // mouth from her lips, drawn a little smaller for a cuter look
  const mc = mid(P(13), P(14));
  const shrink = (i) => ({ x: mc.x + (P(i).x - mc.x) * 0.88, y: mc.y + (P(i).y - mc.y) * 0.88 });
  const top = LIP_TOP.map(shrink), bot = LIP_BOT.map(shrink);
  const gap = dist(P(13), P(14)) / Math.max(1, faceH);
  ctx.lineWidth = Math.max(2, faceW * 0.02);
  ctx.strokeStyle = INK;
  if (gap > 0.025) {
    ctx.beginPath();
    smoothOpen(ctx, top);
    for (let i = 1; i < bot.length; i++) ctx.lineTo(bot[i].x, bot[i].y);
    ctx.closePath();
    ctx.fillStyle = "#7a2438";
    ctx.fill();
    ctx.save();
    ctx.clip();
    const lowMid = bot[5];
    ctx.beginPath();
    ctx.ellipse(lowMid.x, lowMid.y, faceW * 0.09, faceW * 0.05, roll, 0, Math.PI * 2);
    ctx.fillStyle = "#ff8fa8";
    ctx.fill();
    ctx.restore();
    ctx.stroke();
  } else {
    ctx.beginPath();
    smoothOpen(ctx, top);
    ctx.stroke();
    // a hint of pink lower lip
    const lm = bot[5];
    ctx.beginPath();
    ctx.ellipse(lm.x + dx * faceW * 0.012, lm.y + dy * faceW * 0.012, faceW * 0.045, faceW * 0.014, roll, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(225,95,125,.45)";
    ctx.fill();
  }

  ctx.restore();
}
