// Ported from Cenat shared/graphics.mjs. Keep the deterministic marks used by its renderer.
const graphicOf = (id) => ["arrow", "curve", "loop", "line", "disc", "badge"].includes(id) ? { id } : null;
// ---- seeded noise ------------------------------------------------------------
export function seedOf(id) {
  let h = 2166136261;
  for (const c of String(id ?? "")) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Smooth, organic drift in -1..1 along u∈[0,1]: two sines with seeded phase.
function drift(seed) {
  const r = rng(seed);
  const [p1, p2, f1, f2] = [r() * 6.28, r() * 6.28, 1.2 + r() * 1.3, 2.6 + r() * 2.2];
  return (u) => 0.65 * Math.sin(u * f1 * 6.28 + p1) + 0.35 * Math.sin(u * f2 * 6.28 + p2);
}

// ---- polylines -----------------------------------------------------------------
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export function polyLength(points) {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += dist(points[i - 1], points[i]);
  return n;
}
// The first `length` px of a polyline: how a path "draws on".
export function truncate(points, length) {
  if (length <= 0 || points.length < 2) return points.slice(0, 1);
  const out = [points[0]];
  let left = length;
  for (let i = 1; i < points.length; i++) {
    const d = dist(points[i - 1], points[i]);
    if (left >= d) {
      out.push(points[i]);
      left -= d;
    } else {
      const t = d ? left / d : 0;
      out.push([points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t]);
      break;
    }
  }
  return out;
}
export const toPath = (points) => points.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
const sample = (fn, count) => Array.from({ length: count + 1 }, (_, i) => fn(i / count));
const clamp01 = (n) => Math.max(0, Math.min(1, n));

// A slightly bowed, slightly wobbly line: p0 → p1.
export function wobbleLine(p0, p1, { seed = 1, bow = 0.03, wobble = 0.012, step = 8 } = {}) {
  const len = dist(p0, p1);
  const count = Math.max(6, Math.round(len / step));
  const nx = len ? -(p1[1] - p0[1]) / len : 0;
  const ny = len ? (p1[0] - p0[0]) / len : 1;
  const d = drift(seed);
  const side = rng(seed)() < 0.5 ? -1 : 1;
  return sample((u) => {
    const off = side * bow * len * Math.sin(Math.PI * u) + wobble * len * d(u) * Math.sin(Math.PI * u);
    return [p0[0] + (p1[0] - p0[0]) * u + nx * off, p0[1] + (p1[1] - p0[1]) * u + ny * off];
  }, count);
}
// A cubic curve from p0 to p1, bent to one side by `bend` × its length.
export function curvePoints(p0, p1, { seed = 1, bend = 0.28, step = 6 } = {}) {
  const len = dist(p0, p1);
  const nx = len ? -(p1[1] - p0[1]) / len : 0;
  const ny = len ? (p1[0] - p0[0]) / len : 1;
  const side = rng(seed)() < 0.5 ? -1 : 1;
  const c1 = [p0[0] + (p1[0] - p0[0]) * 0.25 + nx * side * bend * len, p0[1] + (p1[1] - p0[1]) * 0.25 + ny * side * bend * len];
  const c2 = [p0[0] + (p1[0] - p0[0]) * 0.75 + nx * side * bend * len * 0.5, p0[1] + (p1[1] - p0[1]) * 0.75 + ny * side * bend * len * 0.5];
  return sample((u) => {
    const m = 1 - u;
    return [
      m * m * m * p0[0] + 3 * m * m * u * c1[0] + 3 * m * u * u * c2[0] + u * u * u * p1[0],
      m * m * m * p0[1] + 3 * m * m * u * c1[1] + 3 * m * u * u * c2[1] + u * u * u * p1[1],
    ];
  }, Math.max(8, Math.round(len / step)));
}
// A loop drawn around a region: a bit more than one turn, drifting in radius so
// the end overshoots the start the way a real pen does.
export function loopPoints(cx, cy, rx, ry, { seed = 1, turns = 1.07, tilt = 0.06 } = {}) {
  const d = drift(seed);
  const r = rng(seed);
  const start = -1.9 + r() * 0.6;
  const dir = r() < 0.5 ? 1 : -1;
  const count = Math.max(40, Math.round((rx + ry) / 3));
  return sample((u) => {
    const a = start + dir * u * turns * 2 * Math.PI;
    const grow = 1 + 0.045 * d(u) + 0.05 * u; // widens slightly as it goes round
    const x = Math.cos(a) * rx * grow;
    const y = Math.sin(a) * ry * grow;
    return [cx + x * Math.cos(tilt) - y * Math.sin(tilt), cy + x * Math.sin(tilt) + y * Math.cos(tilt)];
  }, count);
}

// ---- primitives ------------------------------------------------------------------
// {t:"stroke", subpaths:[points…], width, color, cap, dash?, alpha}
// {t:"disc", cx, cy, r, color, alpha}
// {t:"badge", x, y, w, h, radius, color, label, labelColor, fontSize, alpha}
// Reveal `progress` of a stroke's total length, in order across its subpaths.
export function revealSubpaths(subpaths, progress) {
  const total = subpaths.reduce((n, s) => n + polyLength(s), 0);
  let left = clamp01(progress) * total;
  const out = [];
  for (const s of subpaths) {
    const len = polyLength(s);
    if (left <= 0) break;
    out.push(left >= len ? s : truncate(s, left));
    left -= len;
  }
  return out;
}
const stroke = (subpaths, width, color, extra = {}) => ({ t: "stroke", subpaths, width, color, cap: "round", alpha: 1, ...extra });

// ---- text styles -------------------------------------------------------------------
const luma = (hex) => {
  const n = parseInt(String(hex).slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};
export const isLight = (hex) => luma(hex) > 0.6;
// ---- graphics ----------------------------------------------------------------------
export const GRAPHIC_DRAW_SECONDS = { draw: 0.6, pop: 0.3, fade: 0.3, none: 0 };
export const GRAPHIC_DEFAULT_COLOR = { arrow: "#ff3b30", curve: "#2b2b2b", loop: "#ff3b30", line: "#ff3b30", disc: "#4aa3ff", badge: "#2ea86b" };

// Primitives for a graphic layer at `progress` (0–1) of its entrance, in canvas
// px. `canvas` is {w, h}. A layer's own `animation` decides how it arrives:
// draw (strokes trace on), pop (scale up), fade.
export function graphicPrimitives(layer, canvas, progress) {
  const def = graphicOf(layer.graphic);
  if (!def) return [];
  const { w, h } = canvas;
  const animation = layer.animation || "draw";
  const color = layer.color || GRAPHIC_DEFAULT_COLOR[layer.graphic];
  const seed = seedOf(layer.id);
  const p0 = [layer.x * w, layer.y * h];
  const p1 = [(layer.x2 ?? layer.x) * w, (layer.y2 ?? layer.y) * h];
  const lineWidth = Math.max(3, (layer.strokeWidth ?? 0.008) * h);
  const drawn = animation === "draw" ? clamp01(progress) : 1;
  const alpha = animation === "fade" ? clamp01(progress) : 1;
  const grow = animation === "pop" ? 0.55 + 0.45 * easeOutBack(clamp01(progress)) : 1;
  const fade = animation === "pop" ? clamp01(progress * 3) : alpha;
  if (layer.graphic === "arrow") {
    const shaft = curvePoints(p0, p1, { seed, bend: 0.12, step: 6 });
    const len = dist(p0, p1);
    const head = Math.max(h * 0.03, Math.min(len * 0.28, h * 0.09));
    const end = shaft.at(-1);
    const before = shaft[Math.max(0, shaft.length - 4)];
    const angle = Math.atan2(end[1] - before[1], end[0] - before[0]);
    const wing = (side) => [
      [end[0] - Math.cos(angle + side * 0.5) * head, end[1] - Math.sin(angle + side * 0.5) * head],
      end,
    ];
    return [stroke(revealSubpaths([shaft, wing(1), wing(-1)], drawn), lineWidth, color, { alpha: fade })];
  }
  if (layer.graphic === "curve") {
    const line = curvePoints(p0, p1, { seed, bend: 0.32, step: 6 });
    return [stroke(revealSubpaths([line], drawn), Math.max(2.5, lineWidth * 0.7), color, { dash: [lineWidth * 2.6, lineWidth * 2.2], alpha: fade })];
  }
  if (layer.graphic === "line")
    return [stroke(revealSubpaths([wobbleLine(p0, p1, { seed, bow: 0.02, wobble: 0.02 })], drawn), lineWidth, color, { alpha: fade })];
  if (layer.graphic === "loop") {
    const ry = ((layer.size ?? 0.12) * h) / 2;
    const rx = ((layer.width ?? (layer.size ?? 0.12) * (h / w) * 2.2) * w) / 2;
    return [stroke(revealSubpaths([loopPoints(p0[0], p0[1], rx, ry, { seed })], drawn), lineWidth, color, { alpha: fade })];
  }
  if (layer.graphic === "disc") return [{ t: "disc", cx: p0[0], cy: p0[1], r: (((layer.size ?? 0.4) * h) / 2) * grow, color, alpha: fade }];
  if (layer.graphic === "badge") {
    const label = String(layer.label ?? "").slice(0, 3);
    const hh = (layer.size ?? 0.09) * h * grow;
    const ww = hh * (label.length > 1 ? 0.6 + 0.32 * label.length : 1);
    return [{ t: "badge", x: p0[0] - ww / 2, y: p0[1] - hh / 2, w: ww, h: hh, radius: hh * 0.24, color, label, labelColor: isLight(color) ? "#111111" : "#ffffff", fontSize: hh * 0.58, alpha: fade }];
  }
  return [];
}
const easeOutBack = (u) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (u - 1) ** 3 + c1 * (u - 1) ** 2;
};
