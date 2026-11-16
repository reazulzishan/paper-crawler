// crawler.js - the spider's brain and body.
//
//   update(dt)  brain (where to go) -> body (move/turn) -> legs (IK + gait)
//               -> feet (anchor to words) -> effects (markup) -> camera.
//               READS the DOM only (rects, elementFromPoint, scrollY).
//   draw()      paints the canvas from the computed state (spider-draw.js).
//   commit()    applies every queued DOM WRITE (class changes, scrollTo) in
//               one batch, so the browser does at most one layout per frame.
//
// All spider positions are in PAGE coordinates (document space), so when the
// paper scrolls, the spider scrolls with it as if it were standing on it.
// Screen position = page position - scroll.

import { drawSpider, fitCanvas } from "./spider-draw.js";
import { sectionAt, measureSections } from "./loader.js";

// ---------------------------------------------------------------- tuning
const UPPER = 34, LOWER = 40;            // leg bone lengths (px)
const REACH = UPPER + LOWER;
const STEP_THRESHOLD = 22;               // foot this far from its rest spot -> step
const SPEED = { read: 62, chase: 190, run: 280 };
const INTENSITY = {
  calm:   { p: 0.22, neighbor: 0.03, line: 0.01 },
  normal: { p: 0.55, neighbor: 0.12, line: 0.05 },
  wild:   { p: 0.95, neighbor: 0.35, line: 0.14 },
};
const SECTION_DWELL = 1.2;               // seconds in a section before we ask the AI about it

// Leg layout per side, front (0) to back (3): where it mounts on the thorax,
// the rest-pose angle from the heading, and how far out the foot rests.
const LEG_DEFS = [
  { mx: 5,  angle: 35,  dist: 64 },
  { mx: 2,  angle: 72,  dist: 58 },
  { mx: -1, angle: 108, dist: 56 },
  { mx: -4, angle: 148, dist: 64 },
];

// ---------------------------------------------------------------- tiny math
const rad = (d) => (d * Math.PI) / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// 1D value noise in [-1, 1]: smooth randomness for wandering.
function hash(i) {
  i = Math.imul(i ^ 0x27d4eb2d, 0x165667b1);
  i ^= i >>> 15;
  return ((i & 0xffff) / 0x8000) - 1;
}
function noise(x) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return lerp(hash(i), hash(i + 1), u);
}

/**
 * Two-bone IK by the law of cosines.
 * Given hip H, foot F and bone lengths a (upper) and b (lower):
 *   d   = |F - H|            (clamped so the triangle exists)
 *   cos(alpha) = (a^2 + d^2 - b^2) / (2ad)   angle at the hip between H->F and H->knee
 *   knee = H + a * (cos(base + bend*alpha), sin(base + bend*alpha))
 * `bend` (+1/-1) picks which of the two possible knees we use.
 */
export function solveIK(hip, foot, a, b, bend) {
  const dx = foot.x - hip.x, dy = foot.y - hip.y;
  const d = clamp(Math.hypot(dx, dy), Math.abs(a - b) + 0.01, a + b - 0.01);
  const base = Math.atan2(dy, dx);
  const alpha = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));
  const k = base + bend * alpha;
  return { x: hip.x + a * Math.cos(k), y: hip.y + a * Math.sin(k) };
}

// ---------------------------------------------------------------- smart targeting
// What kind of thing is this word? Important kinds get ~3x the chance of a
// dramatic markup, so the spider looks like it's hunting for what matters.
const DATASETS = /^(imagenet|wmt|glue|superglue|squad|coco|mmlu|cifar|mnist|hellaswag|gsm8k|humaneval|lambada|wikitext|ptb|penn|bookcorpus|c4|librispeech|kinetics|ade20k|triviaqa|mnli|sst|conll|winogrande|piqa|commoncrawl|laion|openwebtext|the\s?pile|naturalquestions|ms-?marco|swag|race|qnli|rte|mrpc|cola|sts-?b)/i;
const KNOWN_MODELS = /^(transformers?|bert|gpt|lstm|rnn|cnn|resnet|lora|vit|clip|t5|llama|gan|vae|unet|u-net|adam|dropout|attention|self-attention|multi-head|encoder|decoder|diffusion)/i;
const CLAIMS = /^(propose[sd]?|introduce[sd]?|outperform(s|ed|ing)?|novel|surpass(es|ed)?|achiev(e|es|ed)|superior|state-of-the-art|sota|significantly|improve[sd]?|first|best|new)\b/i;
const METRIC_WORDS = /^(bleu|rouge|f1|accuracy|perplexity|ppl|top-?1|top-?5|em|map|auc|flops|params?)\b/i;

export function classify(el) {
  const t = el.textContent.trim();
  if (el.closest("cite") || /^\[\d+([,–\-]\s*\d+)*\]/.test(t) || /^et$|^al\.?,?$/.test(t)) return "citation";
  if (el.closest(".ltx_tag_equation") || /^\(\d+\)[.,]?$/.test(t)) return "equation";
  if (/^[(\[]?[+\-−±]?(\d+\.\d+|\d+(\.\d+)?%|\d{2,})[%x×]?[)\],.;:]*$/.test(t) || METRIC_WORDS.test(t)) return "metric";
  if (DATASETS.test(t)) return "dataset";
  if (/[a-z][A-Z]/.test(t) || /^[A-Z][A-Z0-9\-]{1,}[,.;:)]*$/.test(t) || KNOWN_MODELS.test(t)) return "model";
  if (CLAIMS.test(t)) return "claim";
  return null;
}

// ---------------------------------------------------------------- the crawler
export class Crawler {
  /**
   * companion: true = reading-buddy mode for the Chrome extension. The spider
   * follows wherever YOU scroll instead of scrolling the page itself, doesn't
   * chase the mouse (Alt+click sends it somewhere), and marks up gently.
   */
  constructor({ canvas, paperEl, onSection, onNote, companion = false }) {
    this.canvas = canvas;
    this.paperEl = paperEl;
    this.onSection = onSection || (() => {});
    this.onNote = onNote || (() => {});
    this.debug = new URLSearchParams(location.search).has("debug");
    this.companion = companion;
    this.paused = false;
    this.follow = !companion;
    this.intensity = companion ? "calm" : "normal";

    this.pos = { x: innerWidth / 2, y: -100 };
    this.vel = { x: 0, y: 0 };
    this.angle = Math.PI / 2;
    this.mode = "idle";             // idle | drop | walk
    this.time = 0;
    this.writes = [];               // queued DOM writes, flushed in commit()
    this.touched = [];              // recently touched words (silk threads)
    this.walked = new Set();        // paragraphs the spider has walked over
    this.noted = new Set();
    this.pauseFor = 0;
    this.goal = null;               // {x, y, onArrive} for click / AI pointing
    this.mouse = null;              // {cx, cy, t} last cursor position (client)
    this.lastManualScroll = -1e9;
    this.expectScrollY = null;
    this.sectionIdx = -1;
    this.pendingSection = { idx: -1, t: 0 };
    this.fps = 60;
    this.thread = null;

    // Build the 8 legs. group 0 = L1,R2,L3,R4 ; group 1 = R1,L2,R3,L4 (alternating tetrapod).
    this.legs = [];
    for (const side of [-1, 1]) {
      LEG_DEFS.forEach((d, i) => {
        this.legs.push({
          name: (side < 0 ? "L" : "R") + (i + 1),
          side, ...d,
          group: (i + (side < 0 ? 0 : 1)) % 2,
          threshold: STEP_THRESHOLD + rand(-3, 4),
          foot: { x: 0, y: 0 },
          anchor: null,             // {el, fx, fy} foot glued to a word
          step: null,               // {from, to, t, dur, anchor}
          bend: 1,
          lift: 0,
        });
      });
    }
    // Fix each leg's knee direction once: whichever IK solution puts the knee
    // farther from the body axis in the rest pose (mirrored per side).
    for (const L of this.legs) {
      const hip = { x: L.mx, y: L.side * 4 };
      const rest = { x: Math.cos(rad(L.side * L.angle)) * L.dist, y: Math.sin(rad(L.side * L.angle)) * L.dist };
      const k1 = solveIK(hip, rest, UPPER, LOWER, 1), k2 = solveIK(hip, rest, UPPER, LOWER, -1);
      L.bend = Math.abs(k1.y) > Math.abs(k2.y) ? 1 : -1;
    }

    this.bindInput();
    addEventListener("resize", () => this.measure());
    if (this.debug) window.__crawler = this;
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------ setup
  setPaper(paper) {
    this.paper = paper;
    this.sections = paper.sections;
    this.walked.clear();
    this.noted.clear();
    this.touched = [];
    this.sectionIdx = -1;
    // Images load late and push headings down: re-measure as they arrive.
    paper.article.querySelectorAll("img").forEach((img) => img.addEventListener("load", () => this.measure(), { once: true }));
    this.measure();
    this.drop();
  }

  measure() {
    if (!this.sections) return;
    measureSections(this.sections);
    const r = this.paperEl.getBoundingClientRect();
    this.column = { left: r.left + scrollX + 60, width: Math.max(100, r.width - 120) };
    const refs = this.sections.find((s) => s.isReferences);
    this.refsTop = refs ? refs.top : Infinity;
  }

  /** D: re-drop from the top of the screen on a silk thread. */
  drop() {
    this.measure();
    if (this.companion) {
      // land wherever the reader is looking; never move their page
      this.landing = { x: this.column.left + this.column.width / 2, y: scrollY + innerHeight * 0.4 };
    } else {
      const land = (this.sections.find((s) => s.title === "Title") || this.sections[0]).heading.getBoundingClientRect();
      this.landing = { x: land.left + scrollX + land.width / 2, y: land.bottom + scrollY + 50 };
      this.writes.push(() => scrollTo({ top: 0 }));
      this.expectScrollY = 0;
    }
    this.pos = { x: this.landing.x, y: -120 };
    this.vel = { x: 0, y: 0 };
    this.angle = Math.PI / 2;        // head down the page
    this.mode = "drop";
    this.dropT = 0;
    this.goal = null;
    this.readY = this.landing.y;
    this.thread = { attachX: this.landing.x - scrollX, alpha: 1, snapT: 0 };
    for (const L of this.legs) { L.anchor = null; L.step = null; }
  }

  // ------------------------------------------------------------ public API (used by analyst.js)
  /** Run to an element list (e.g. AI KEY phrase) and call onArrive there. */
  pointAt(spans, onArrive) {
    const r = spans[0].getBoundingClientRect();
    this.goTo(r.left + scrollX + r.width / 2, r.top + scrollY + r.height / 2, onArrive);
  }
  goTo(x, y, onArrive) {
    this.goal = { x, y, onArrive };
    this.lastManualScroll = -1e9;   // let the camera follow the run
  }
  /** Queue a DOM write to run in commit(). */
  write(fn) { this.writes.push(fn); }

  clearMarkup() {
    this.writes.push(() => {
      for (const el of this.paperEl.querySelectorAll('[class*="m-"]')) {
        [...el.classList].filter((c) => c.startsWith("m-")).forEach((c) => el.classList.remove(c));
        el.style.removeProperty("--mc");
      }
    });
    this.touched = [];
  }

  currentSection() { return this.sections?.[Math.max(0, this.sectionIdx)]; }

  // ------------------------------------------------------------ input
  bindInput() {
    const ui = (e) => e.target.closest?.("#panel, #bar");
    if (!this.companion) {
      addEventListener("mousemove", (e) => { if (!ui(e)) this.mouse = { cx: e.clientX, cy: e.clientY, t: this.time }; });
      addEventListener("mouseleave", () => (this.mouse = null));
    }
    addEventListener("click", (e) => {
      if (this.companion && !e.altKey) return; // don't hijack normal clicks on someone's reading page
      if (ui(e) || e.target.closest("a") || String(getSelection())) return;
      this.goTo(e.clientX + scrollX, e.clientY + scrollY);
    });
    // Manual scroll pauses the camera for 2.5s.
    const manual = () => (this.lastManualScroll = performance.now());
    addEventListener("wheel", manual, { passive: true });
    addEventListener("touchmove", manual, { passive: true });
    addEventListener("scroll", () => {
      if (this.expectScrollY === null || Math.abs(scrollY - this.expectScrollY) > 3) manual();
    }, { passive: true });
  }

  // ------------------------------------------------------------ main loop
  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.fps = Math.round(lerp(this.fps, 1 / Math.max(dt, 1e-3), 0.05));
    if (!this.paused && this.sections) this.update(dt);
    this.draw();
    this.commit();
    requestAnimationFrame((t) => this.frame(t));
  }

  update(dt) {
    this.time += dt;
    this.scroll = { x: scrollX, y: scrollY };
    if (this.mode === "drop") this.updateDrop(dt);
    else if (this.mode === "walk") { this.updateBrain(dt); this.updateBody(dt); }
    this.updateLegs(dt);
    this.updateThread(dt);
    if (this.mode === "walk") { this.updateSection(dt); this.updateCamera(dt); }
  }

  // ------------------------------------------------------------ entrance: drop on silk
  updateDrop(dt) {
    this.dropT += dt / 1.8;
    const t = Math.min(1, this.dropT);
    // ease-out with a small bounce at the end, like a spring in the thread
    const e = 1 - Math.pow(1 - t, 3) + Math.sin(t * Math.PI) * 0.04;
    this.pos.y = lerp(scrollY - 120, this.landing.y, e);
    this.pos.x = this.landing.x + Math.sin(this.time * 2.2) * 10 * (1 - t);
    if (t >= 1) {
      this.mode = "walk";
      this.pauseFor = 1.2;            // look around before reading
      this.threadLen = 0;
      // Splay: every leg steps out at once, slightly staggered.
      this.legs.forEach((L, i) => this.startStep(L, this.restPoint(L), 0.16 + i * 0.018));
    }
  }

  updateThread(dt) {
    const th = this.thread;
    if (!th) return;
    if (this.mode === "walk" && !th.snapT && dist(this.pos, this.landing) > 220) th.snapT = 1e-3;
    if (th.snapT) {
      th.snapT += dt / 0.45;
      th.alpha = Math.max(0, 1 - th.snapT);
      if (th.snapT >= 1) this.thread = null;
    }
  }

  // ------------------------------------------------------------ brain: pick a target
  updateBrain(dt) {
    const mouseActive = this.mouse && this.time - this.mouse.t < 1.4;
    if (this.goal) {
      this.target = this.goal;
      this.speed = clamp(dist(this.pos, this.goal) * 0.9, SPEED.run, 700); // sprint on long runs
      if (dist(this.pos, this.goal) < 12) {
        const g = this.goal;
        this.goal = null;
        this.pauseFor = 1.5;
        this.readY = Math.max(this.pos.y, this.readY - 400);
        g.onArrive?.();
      }
      this.chasing = false;
      return;
    }
    if (mouseActive) {
      this.target = { x: this.mouse.cx + scrollX, y: this.mouse.cy + scrollY };
      this.speed = SPEED.chase;
      this.chasing = true;
      return;
    }
    if (this.chasing) { this.chasing = false; this.readY = this.pos.y; } // resume reading from here

    // Reading: a point drifts down the page; x wanders across the column.
    this.speed = SPEED.read;
    if (this.pauseFor > 0) { this.pauseFor -= dt; this.target = { ...this.pos }; return; }
    if (Math.random() < dt * 0.12) this.pauseFor = rand(0.6, 1.6); // stop to "read"
    if (this.companion) {
      // read where the reader reads: just above the middle of their screen
      this.readY = scrollY + innerHeight * 0.45;
      if (Math.abs(this.readY - this.pos.y) > 250) { this.speed = SPEED.chase; this.pauseFor = 0; }
    } else if (this.pos.y > this.readY - 90) this.readY += 26 * dt;
    this.readY = Math.min(this.readY, this.refsTop - 40); // stop at References
    const c = this.column;
    this.target = {
      x: c.left + c.width * (0.5 + 0.46 * noise(this.time * 0.07 + 3)),
      y: this.readY + 40 * noise(this.time * 0.31 + 11),
    };
  }

  // ------------------------------------------------------------ body: steer, move, turn
  updateBody(dt) {
    const dx = this.target.x - this.pos.x, dy = this.target.y - this.pos.y;
    const d = Math.hypot(dx, dy);
    // "arrive" steering: full speed far away, slow down near the target
    const want = d < 3 ? 0 : Math.min(this.speed, d * 2.2);
    const vx = d ? (dx / d) * want : 0, vy = d ? (dy / d) * want : 0;
    const k = Math.min(1, dt * 4);
    this.vel.x += (vx - this.vel.x) * k;
    this.vel.y += (vy - this.vel.y) * k;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    const sp = Math.hypot(this.vel.x, this.vel.y);
    if (sp > 6) {
      const turn = angleDiff(this.angle, Math.atan2(this.vel.y, this.vel.x));
      this.angle += clamp(turn, -6 * dt, 6 * dt);
    }
  }

  // ------------------------------------------------------------ legs: IK + gait + foot anchoring
  hipPoint(L) {
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    const lx = L.mx, ly = L.side * 4;
    return { x: this.pos.x + lx * c - ly * s, y: this.pos.y + lx * s + ly * c };
  }
  restPoint(L, lead = 0) {
    const a = this.angle + rad(L.side * L.angle);
    return {
      x: this.pos.x + Math.cos(a) * L.dist + this.vel.x * lead,
      y: this.pos.y + Math.sin(a) * L.dist + this.vel.y * lead,
    };
  }

  updateLegs(dt) {
    const speed = Math.hypot(this.vel.x, this.vel.y);
    const stepping = [false, false];
    for (const L of this.legs) if (L.step) stepping[L.group] = true;

    for (const L of this.legs) {
      L.hip = this.hipPoint(L);
      L.rest = this.restPoint(L);

      if (this.mode === "drop") {
        // legs tucked in close while hanging on the thread
        const a = this.angle + rad(L.side * L.angle * 0.8);
        L.foot = { x: L.hip.x + Math.cos(a) * 12, y: L.hip.y + Math.sin(a) * 12 };
        L.lift = 1;
        continue;
      }

      if (L.step) {
        // swing: eased arc from `from` to `to` (target follows its word if anchored)
        const S = L.step;
        S.t += dt / S.dur;
        const to = S.anchor ? this.anchorPos(S.anchor) || S.to : S.to;
        const e = easeInOut(Math.min(1, S.t));
        L.foot = { x: lerp(S.from.x, to.x, e), y: lerp(S.from.y, to.y, e) };
        L.lift = Math.sin(Math.PI * Math.min(1, S.t));
        if (S.t >= 1) { L.step = null; L.lift = 0; L.anchor = S.anchor; this.plant(L); }
        continue;
      }

      // planted: follow the word it's standing on (scroll + reflow)
      if (L.anchor) {
        const p = this.anchorPos(L.anchor);
        if (!p || dist(p, L.foot) > 30) { L.anchor = null; L.mustStep = true; } // word reflowed away
        else L.foot = p;
      }

      const fromRest = dist(L.foot, L.rest);
      const over = dist(L.foot, L.hip) > REACH * 0.96;
      const wants = fromRest > L.threshold || L.mustStep;
      // Tetrapod rule: a leg may step only while the other group is planted,
      // unless it's over-extended (then it steps right away).
      if (over || (wants && !stepping[1 - L.group])) {
        const dur = clamp(0.18 - speed * 0.00025, 0.12, 0.18);
        this.startStep(L, this.restPoint(L, dur * 0.9), dur);
        stepping[L.group] = true;
        L.mustStep = false;
      }
    }
  }

  startStep(L, target, dur) {
    const snap = this.snapFoot(target);
    L.step = { from: { ...L.foot }, to: snap.pos, anchor: snap.anchor, t: 0, dur };
    L.anchor = null;
  }

  /** Page position of an anchored foot, or null if its word is gone. Layout read. */
  anchorPos(a) {
    if (!a.el.isConnected) return null;
    const r = a.el.getBoundingClientRect();
    if (!r.width) return null;
    return { x: r.left + this.scroll.x + a.fx * r.width, y: r.top + this.scroll.y + a.fy * r.height };
  }

  /**
   * Find a foothold near page point p: the nearest .w word, link or table cell
   * under it (probing a small ring around p if the exact point misses).
   */
  snapFoot(p) {
    const cx = p.x - this.scroll.x, cy = p.y - this.scroll.y;
    if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return { pos: p, anchor: null };
    const probes = [[0, 0]];
    for (const r of [10, 20]) for (let i = 0; i < 8; i++) probes.push([Math.cos(i * 0.785) * r, Math.sin(i * 0.785) * r]);
    for (const [ox, oy] of probes) {
      const hit = document.elementFromPoint(cx + ox, cy + oy);
      const el = hit?.closest?.(".w, a, td, th");
      if (!el || !this.paperEl.contains(el)) continue;
      const r = el.getBoundingClientRect();
      const fx = clamp((cx - r.left) / r.width, 0.15, 0.85);
      const fy = clamp((cy - r.top) / r.height, 0.3, 0.8);
      const anchor = { el, fx, fy };
      return { pos: { x: r.left + this.scroll.x + fx * r.width, y: r.top + this.scroll.y + fy * r.height }, anchor };
    }
    return { pos: p, anchor: null };
  }

  // ------------------------------------------------------------ effects: markup on every plant
  plant(L) {
    const el = L.anchor?.el;
    if (!el) return;
    this.touched.push(el);
    if (this.touched.length > 4) this.touched.shift();
    const para = el.closest(".ltx_p, p, td, figcaption, li");
    if (para) this.walked.add(para);
    if (this.mode === "walk") this.markup(el);
  }

  markup(el) {
    const I = INTENSITY[this.intensity];
    const isWord = el.classList.contains("w");
    const kind = isWord ? classify(el) : null;
    const important = kind && kind !== "citation" && kind !== "equation";
    if (kind) this.note(el, kind);
    if (Math.random() > Math.min(1, I.p * (kind ? 3 : 1))) return;
    if ([...el.classList].some((c) => c.startsWith("m-")) && !important) return; // keep the trail; don't stack

    if (!isWord) return this.addClass(el, pick(BOXES));
    const t = el.textContent.trim();
    let cls;
    switch (kind) {
      case "metric":   cls = pick([["m-blowup"], ["m-blowup", "m-red"], ["m-hl-orange", "m-big"], ["m-box-red"], ["m-hl-orange"]]); break;
      case "model":    cls = pick([["m-hl-magenta", "m-wide"], ["m-hl-magenta"], ["m-hl-orange"], t.length < 14 ? ["m-rotate-green"] : ["m-box-purple"], ["m-color-text"]]); break;
      case "dataset":  cls = pick([["m-hl-magenta"], ["m-box-purple"], ["m-hl-orange", "m-big"], ["m-rotate-green"]]); break;
      case "citation": cls = pick([["m-box-orange"], ["m-hl-green"], ["m-color-text"]]); break;
      case "equation": cls = pick([["m-blowup", "m-red"], ["m-box-red"]]); break;
      case "claim":    cls = pick([["m-hl-orange"], ["m-hl-green"], ["m-rotate-green"], ["m-hl-magenta", "m-wide"]]); break;
      default: {
        const r = Math.random();
        cls = r < 0.42 ? [pick(BOXES)] : r < 0.62 ? ["m-hl-green"] : r < 0.78 ? ["m-color-text"]
          : r < 0.86 ? ["m-hl-orange"] : r < 0.93 ? ["m-hl-magenta"] : r < 0.97 ? ["m-hl-cyan"] : ["m-rotate-green"];
      }
    }
    this.addClass(el, ...cls);

    // Occasionally mark nearby words too, or the whole line.
    if (Math.random() < I.neighbor) {
      let n = el;
      for (let i = 0, k = 1 + (Math.random() * 3) | 0; i < k; i++) {
        n = n.nextElementSibling;
        if (!n?.classList.contains("w")) break;
        this.addClass(n, pick(["m-hl-green", "m-color-text", pick(BOXES)]));
      }
    }
    if (Math.random() < I.line) this.markLine(el, pick(["m-hl-cyan", "m-hl-green"]));
  }

  /** Mark every word on the same visual line as el (layout read now, write later). */
  markLine(el, cls) {
    const top = el.getBoundingClientRect().top;
    const words = [...el.parentElement.children].filter((w) => w.classList.contains("w"));
    for (const w of words) if (Math.abs(w.getBoundingClientRect().top - top) < 4) this.addClass(w, cls);
  }

  addClass(el, ...cls) {
    const color = cls.includes("m-color-text") ? pick(["#7b2cff", "#e0303a", "#0f8fa0", "#ff5a1f", "#11a84a"]) : null;
    this.writes.push(() => {
      el.classList.add(...cls);
      if (color) el.style.setProperty("--mc", color);
    });
  }

  /** Log metrics/models/datasets to Crawler Notes, with section + sentence. */
  note(el, kind) {
    if (!["metric", "model", "dataset"].includes(kind)) return;
    const word = el.textContent.trim().replace(/[,.;:)\]]+$/, "").replace(/^[(\[]/, "");
    const section = this.currentSection()?.title || "";
    const key = kind + word + section;
    if (this.noted.has(key)) return;
    this.noted.add(key);
    const block = el.closest(".ltx_p, p, td, figcaption, li");
    const text = (block?.textContent || "").replace(/\s+/g, " ");
    const sentence = (text.split(/(?<=[.!?])\s+/).find((s) => s.includes(word)) || text).slice(0, 260);
    this.onNote({ type: kind, word, section, sentence });
  }

  // ------------------------------------------------------------ sections
  updateSection(dt) {
    const idx = sectionAt(this.sections, this.pos.y);
    if (idx !== this.sectionIdx) {
      this.sectionIdx = idx;
      const s = this.sections[idx];
      if (!s.isAbstract && s.title !== "Title") this.addClass(s.heading, "m-hl-purple");
      this.pendingSection = { idx, t: 0 };
    }
    // Only tell the AI once we've stayed a moment (don't bill for fly-overs).
    const p = this.pendingSection;
    if (p.idx >= 0 && !this.goal) {
      p.t += dt;
      if (p.t > (this.companion ? 2.5 : SECTION_DWELL)) { this.onSection(this.sections[p.idx], p.idx); p.idx = -1; }
    }
  }

  // ------------------------------------------------------------ camera
  updateCamera(dt) {
    if (!this.follow || this.chasing) return;          // chasing the mouse + scrolling would feed back
    if (performance.now() - this.lastManualScroll < 2500) return;
    let want = this.pos.y - innerHeight * 0.42;
    if (!this.goal) want = Math.min(want, this.refsTop - innerHeight * 0.3); // stop at References
    want = clamp(want, 0, document.documentElement.scrollHeight - innerHeight);
    const dy = want - scrollY;
    if (Math.abs(dy) < 1) return;
    const y = scrollY + dy * Math.min(1, dt * 2.5);
    this.expectScrollY = Math.round(y);
    this.writes.push(() => scrollTo(scrollX, y));
  }

  // ------------------------------------------------------------ draw + commit
  draw() {
    const ctx = fitCanvas(this.canvas);
    const sx = scrollX, sy = scrollY;
    const S = (p) => ({ x: p.x - sx, y: p.y - sy });
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    const local = (lx, ly) => S({ x: this.pos.x + lx * c - ly * s, y: this.pos.y + lx * s + ly * c });

    const legs = this.legs.map((L) => {
      const hip = S(L.hip || this.hipPoint(L));
      const foot = S(L.foot);
      // Fake "lift" in top-down view: raised feet pull toward the hip and up.
      const footDraw = { x: lerp(foot.x, hip.x, L.lift * 0.15), y: foot.y - L.lift * 7 };
      const knee = solveIK(hip, footDraw, UPPER, LOWER, L.bend);
      const r = L.anchor?.el.isConnected && this.debug ? L.anchor.el.getBoundingClientRect() : null;
      return {
        hip, knee, foot, footDraw, lift: L.lift, name: L.name, group: L.group,
        rest: S(L.rest || L.foot), threshold: L.threshold, reach: REACH, anchorRect: r,
      };
    });
    const palp = (side) => ({ a: local(8, side * 2.5), b: local(14, side * 5.5), c: local(18, side * 3.5) });

    let thread = null;
    const tip = local(-31, 0);
    if (this.thread) {
      const th = this.thread;
      const y1 = lerp(tip.y, 0, th.snapT ? Math.min(1, th.snapT) : 0); // recoil upward when snapped
      const x1 = lerp(tip.x, th.attachX, th.snapT ? Math.min(1, th.snapT) : 0);
      const sway = Math.sin(this.time * 1.7) * Math.min(30, y1 * 0.08);
      thread = { x0: th.attachX, y0: 0, cx: (th.attachX + x1) / 2 + sway, cy: y1 / 2, x1, y1, alpha: th.alpha };
    }
    const silk = this.touched.filter((el) => el.isConnected).slice(-3).map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

    drawSpider(ctx, {
      x: this.pos.x - sx, y: this.pos.y - sy, angle: this.angle,
      legs, palps: [palp(-1), palp(1)], abdomenTip: tip, thread, silk,
      debug: this.debug, target: this.target && S(this.target), mode: this.mode, fps: this.fps,
    });
  }

  commit() {
    const w = this.writes;
    if (!w.length) return;
    this.writes = [];
    for (const fn of w) fn();
  }
}

const BOXES = ["m-box-teal", "m-box-purple", "m-box-orange", "m-box-red", "m-box-green"];
