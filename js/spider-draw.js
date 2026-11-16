// spider-draw.js - renders the spider and its silk onto the canvas overlay.
// Pure drawing: it reads the spider state that crawler.js computed and never
// touches the DOM. All positions here are already in screen (client) pixels.

const LEG = "#19c3d6";
const DOT = "#e0303a";

/** Resize the canvas backing store to the viewport at device-pixel-ratio. */
export function fitCanvas(canvas) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = innerWidth, h = innerHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/**
 * Draw one frame.
 * s = { x, y, angle, legs:[{hip, knee, foot, lift}], palps, abdomen, thread, silk:[{x,y}], debug }
 */
export function drawSpider(ctx, s) {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // --- silk: drop thread from the top of the screen ---
  if (s.thread) {
    const t = s.thread;
    ctx.strokeStyle = `rgba(255,255,255,${0.9 * t.alpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(t.x0, t.y0);
    ctx.quadraticCurveTo(t.cx, t.cy, t.x1, t.y1);
    ctx.stroke();
    ctx.strokeStyle = `rgba(0,0,0,${0.35 * t.alpha})`; // dark core so it shows on white paper
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  // --- silk: faint threads to recently touched words ---
  ctx.lineWidth = 0.6;
  for (const p of s.silk) {
    ctx.strokeStyle = "rgba(25,195,214,0.28)";
    ctx.beginPath();
    ctx.moveTo(s.abdomenTip.x, s.abdomenTip.y);
    ctx.quadraticCurveTo((s.abdomenTip.x + p.x) / 2, Math.max(s.abdomenTip.y, p.y) + 18, p.x, p.y);
    ctx.stroke();
  }

  // --- legs (drawn under the body) ---
  for (const L of s.legs) {
    ctx.strokeStyle = LEG;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(L.hip.x, L.hip.y);
    ctx.lineTo(L.knee.x, L.knee.y);
    ctx.lineTo(L.footDraw.x, L.footDraw.y);
    ctx.stroke();
    dot(ctx, L.knee.x, L.knee.y, 2.1, DOT);
    dot(ctx, L.footDraw.x, L.footDraw.y, L.lift > 0.05 ? 1.6 : 2.4, DOT);
  }

  // --- palps: two short feelers at the front ---
  ctx.strokeStyle = LEG;
  ctx.lineWidth = 1.2;
  for (const p of s.palps) {
    ctx.beginPath();
    ctx.moveTo(p.a.x, p.a.y);
    ctx.lineTo(p.b.x, p.b.y);
    ctx.lineTo(p.c.x, p.c.y);
    ctx.stroke();
  }

  // --- body: abdomen + thorax, glossy black, elongated ---
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.angle);
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 3;
  glossy(ctx, -17, 0, 15, 8.5); // abdomen (behind)
  ctx.shadowColor = "transparent";
  glossy(ctx, 1, 0, 8, 5.5);    // thorax / cephalothorax
  dot(ctx, 7.2, 0, 1.3, "#fff"); // the tiny white eye
  ctx.restore();

  if (s.debug) drawDebug(ctx, s);
}

function glossy(ctx, cx, cy, rx, ry) {
  const g = ctx.createRadialGradient(cx - rx * 0.3, cy - ry * 0.45, 0.5, cx, cy, rx);
  g.addColorStop(0, "#5a5f66");
  g.addColorStop(0.25, "#16181b");
  g.addColorStop(1, "#000");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

function dot(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// ?debug overlay: reach circles, step thresholds, rest targets, current target.
function drawDebug(ctx, s) {
  ctx.lineWidth = 1;
  for (const L of s.legs) {
    ctx.strokeStyle = "rgba(255,0,0,0.25)";
    ctx.beginPath(); ctx.arc(L.hip.x, L.hip.y, L.reach, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(0,160,0,0.6)";
    ctx.beginPath(); ctx.arc(L.rest.x, L.rest.y, L.threshold, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,255,0.5)";
    ctx.beginPath(); ctx.moveTo(L.hip.x, L.hip.y); ctx.lineTo(L.foot.x, L.foot.y); ctx.stroke();
    if (L.anchorRect) {
      const r = L.anchorRect;
      ctx.strokeStyle = "rgba(255,0,255,0.7)";
      ctx.strokeRect(r.left, r.top, r.width, r.height);
    }
    ctx.fillStyle = L.group ? "#f0f" : "#0a0";
    ctx.font = "9px monospace";
    ctx.fillText(L.name, L.footDraw.x + 4, L.footDraw.y - 4);
  }
  if (s.target) {
    ctx.strokeStyle = "#ff7a3d";
    ctx.beginPath(); ctx.arc(s.target.x, s.target.y, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.target.x, s.target.y); ctx.stroke();
  }
  ctx.fillStyle = "#000";
  ctx.font = "11px monospace";
  ctx.fillText(`${s.mode}  fps ${s.fps}`, 10, innerHeight - 10);
}
