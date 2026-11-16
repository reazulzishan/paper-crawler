// analyst.js - the AI explainer panel + Crawler Notes.
//
// Pipeline:  crawler enters a section -> we queue {title, section, text}
//            -> POST /api/explain (serve.py adds the key + prompt, calls Claude)
//            -> SSE text deltas type out live in the panel
//            -> the "KEY:" line names an exact phrase -> we find it in the paper
//               and send the spider to hit it with the biggest markup.
// One request at a time; the rest wait in a queue.

import { sectionText, findPhrase, sectionAt } from "./loader.js";

const LEVELS = { beginner: "B", student: "S", researcher: "R" };
const KEY_RE = /^[*_\s]*KEY[*_]*\s*:[*_]*\s*(.+)$/im;

export class Analyst {
  constructor({ panel, crawler }) {
    this.crawler = crawler;
    this.level = "student";
    this.ai = false;
    this.queue = [];
    this.busy = false;
    panel.innerHTML = `
      <header>
        <div class="now">▸ crawling: …</div>
        <div class="row levels">
          ${Object.entries(LEVELS).map(([l, k]) => `<button data-level="${l}" title="key ${k}">${l}</button>`).join("")}
        </div>
        <div class="row">
          <button data-act="md">⤓ breakdown.md</button>
          <button data-act="json">⤓ notes.json</button>
        </div>
      </header>
      <div class="tabs"><button data-tab="explain" class="on">Explainer</button><button data-tab="notes">Crawler Notes <span class="count">0</span></button></div>
      <div class="body" data-pane="explain"><div class="notice-slot"></div><div class="history"></div></div>
      <div class="body" data-pane="notes" hidden><div class="notes"></div></div>`;
    this.$ = (sel) => panel.querySelector(sel);
    panel.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.level) this.setLevel(b.dataset.level);
      if (b.dataset.tab) this.showTab(b.dataset.tab);
      if (b.dataset.act === "md") this.exportMarkdown();
      if (b.dataset.act === "json") this.exportNotes();
    });
    this.setLevel(this.level, false);
  }

  async init() {
    try {
      const s = await (await fetch("api/status")).json();
      this.ai = s.ai;
      if (s.ai) this.$(".now").title = `AI: ${s.backend === "ollama" ? "local " + s.model + " (free, offline)" : "Claude " + s.model}`;
      if (s.backend === "ollama") this.$(".notice-slot").innerHTML =
        `<div class="card"><h4>local AI · ${escapeHtml(s.model)}</h4><p>Free and offline, running on this Mac. The first answer takes a few extra seconds while the model loads.</p></div>`;
    } catch {
      this.ai = false; // e.g. opened via a plain static server
    }
    if (!this.ai) this.showNotice();
  }

  showNotice() {
    this.$(".notice-slot").innerHTML = `<div class="notice"><b>AI explainer is off.</b> For free offline AI, install Ollama
      (<code>brew install ollama</code>, then <code>ollama pull qwen3:8b</code>). Or put a Claude key in
      <code>.env</code> as <code>ANTHROPIC_API_KEY</code>. Then restart <code>python3 serve.py</code>.
      The spider still crawls and marks up the paper.</div>`;
  }

  // ------------------------------------------------------------ paper lifecycle
  setPaper(paper) {
    this.paper = paper;
    this.queue = [];
    this.done = new Map();   // "slug|level" -> entry
    this.entries = [];       // history, in order
    this.notes = [];
    this.$(".history").replaceChildren();
    this.$(".notes").replaceChildren();
    this.$(".count").textContent = "0";
    // Explain the abstract right away as the TL;DR.
    const abs = paper.sections.find((s) => s.isAbstract);
    if (abs) this.request({ kind: "tldr", label: "TL;DR", section: abs, text: sectionText(abs) });
  }

  /** Called by the crawler when its body has settled in a new section. */
  onSection(section) {
    this.$(".now").textContent = `▸ crawling: ${section.title}`;
    if (section.isAbstract || section.isReferences || section.title === "Title") return;
    this.request({ kind: "section", label: section.title, section,
      text: sectionText(section, this.crawler.walked) });
  }

  request(job, urgent = false) {
    job.level = this.level;
    const id = (job.kind === "selection" ? "sel:" + job.text.slice(0, 80) : job.section.slug) + "|" + job.level;
    if (this.done.has(id) || this.queue.some((j) => j.id === id) || !job.text.trim()) return;
    job.id = id;
    if (!this.ai) return;
    urgent ? this.queue.unshift(job) : this.queue.push(job);
    this.pump();
  }

  async pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const job = this.queue.shift();
    const paperAtStart = this.paper;
    try { await this.run(job); } catch (e) { console.error(e); }
    this.busy = false;
    if (paperAtStart === this.paper) this.pump();
  }

  // ------------------------------------------------------------ one streamed explanation
  async run(job) {
    const entry = { label: job.label, kind: job.kind, level: job.level, text: "", key: null, section: job.section.title };
    this.done.set(job.id, entry);
    this.entries.push(entry);
    const card = this.card(entry);
    card.classList.add("live");
    const p = card.querySelector("p");
    p.classList.add("caret");

    const res = await fetch("api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paperId: this.paper.id, title: this.paper.meta.title, section: job.section.title,
        text: job.text, level: job.level, selection: job.kind === "selection",
      }),
    });
    if (!res.ok) {
      // 503 = server has no key; forget this entry so it can be retried later
      this.done.delete(job.id);
      this.entries.splice(this.entries.indexOf(entry), 1);
      card.remove();
      if (res.status === 503) { this.ai = false; this.showNotice(); }
      return;
    }

    // Read the SSE stream by hand: "event: x\ndata: {...}\n\n"
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] || "{}");
        if (ev === "delta") {
          entry.text += data.text;
          this.renderText(entry, card);
          // KEY line is complete once a newline follows it
          const m = KEY_RE.exec(entry.text);
          if (m && !entry.key && /KEY[^\n]*\n/i.test(entry.text)) this.handleKey(entry, card, m[1], job);
        } else if (ev === "error") {
          card.insertAdjacentHTML("beforeend", `<div class="err">${escapeHtml(data.error)}</div>`);
        } else if (ev === "done" && data.cached) {
          card.querySelector("h4").insertAdjacentHTML("beforeend", `<span class="tag">cached</span>`);
        }
      }
    }
    const m = KEY_RE.exec(entry.text);
    if (m && !entry.key) this.handleKey(entry, card, m[1], job);
    p.classList.remove("caret");
    card.classList.remove("live");
  }

  renderText(entry, card) {
    card.querySelector("p").textContent = entry.text.replace(KEY_RE, "").trim();
  }

  /** The spider "points" at what the AI found. */
  handleKey(entry, card, raw, job) {
    const phrase = raw.trim().replace(/^[*_"'“`]+|[*_"'”`]+$/g, "");
    entry.key = phrase;
    const chip = document.createElement("div");
    chip.className = "key";
    chip.textContent = "KEY: " + phrase;
    card.append(chip);
    const go = () => {
      const spans = findPhrase(phrase, this.paper.article, job.root || job.section.container);
      if (!spans) { chip.title = "Couldn't find this exact phrase in the paper"; return; }
      this.crawler.pointAt(spans, () => spans.forEach((s) => this.crawler.addClass(s, "m-key")));
    };
    chip.onclick = go;
    go();
  }

  card(entry) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<h4>${escapeHtml(entry.label)} <span class="tag">${entry.level}</span></h4><p></p>`;
    this.$(".history").prepend(card);
    return card;
  }

  // ------------------------------------------------------------ explain selection (E)
  explainSelection() {
    const sel = getSelection();
    const text = String(sel).trim();
    if (!text || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const r = range.getBoundingClientRect();
    const idx = sectionAt(this.paper.sections, r.top + scrollY);
    const section = this.paper.sections[idx];
    const root = range.commonAncestorContainer.parentElement;
    this.crawler.goTo(r.left + scrollX + Math.min(r.width / 2, 40), r.top + scrollY + r.height / 2);
    if (!this.ai) return;
    this.showTab("explain");
    this.request({ kind: "selection", label: `Selection · ${section.title}`, section, root,
      text: text.slice(0, 4000) }, true);
  }

  setLevel(level, rerun = true) {
    this.level = level;
    this.$(".levels").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.level === level));
    // re-explain where the spider is now, at the new level
    const s = this.crawler.currentSection();
    if (rerun && s && this.paper) {
      if (s.isAbstract || s.title === "Title") this.request({ kind: "tldr", label: "TL;DR", section: s, text: sectionText(s) }, true);
      else this.onSection(s);
    }
  }

  showTab(tab) {
    this.$(".tabs").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    this.$('[data-pane="explain"]').hidden = tab !== "explain";
    this.$('[data-pane="notes"]').hidden = tab !== "notes";
  }

  // ------------------------------------------------------------ crawler notes
  addNote(n) {
    this.notes.push(n);
    this.$(".count").textContent = this.notes.length;
    const div = document.createElement("div");
    div.className = "note";
    div.innerHTML = `<b class="t-${n.type}">${escapeHtml(n.word)}</b> <small>${n.type} · ${escapeHtml(n.section)}</small><small>${escapeHtml(n.sentence)}</small>`;
    this.$(".notes").prepend(div);
  }

  // ------------------------------------------------------------ export
  exportMarkdown() {
    const m = this.paper.meta;
    const out = [`# ${m.title}`, "", `*${m.authors.join(", ")}* · arXiv [${m.id}](https://arxiv.org/abs/${m.id}) · ${m.published}`, ""];
    const tldr = this.entries.find((e) => e.kind === "tldr");
    if (tldr) out.push("## TL;DR", "", clean(tldr.text), "");
    const secs = this.entries.filter((e) => e.kind === "section" && e.text);
    if (secs.length) out.push("## Section by section", "");
    for (const e of secs) out.push(`### ${e.label}`, "", clean(e.text), ...(e.key ? ["", `**Key:** ${e.key}`] : []), "");
    const sels = this.entries.filter((e) => e.kind === "selection");
    if (sels.length) out.push("## Passages explained", "");
    for (const e of sels) out.push(`### ${e.label}`, "", clean(e.text), "");
    const keys = this.entries.filter((e) => e.key).map((e) => `- **${e.key}** (${e.section})`);
    const metrics = this.notes.filter((n) => n.type === "metric").map((n) => `- **${n.word}**: ${n.sentence}`);
    if (keys.length || metrics.length) out.push("## Key results", "", ...keys, ...metrics, "");
    const models = [...new Set(this.notes.filter((n) => n.type !== "metric").map((n) => `${n.word} (${n.type})`))];
    if (models.length) out.push("## Models & datasets mentioned", "", models.join(", "), "");
    download(`${m.id}-breakdown.md`, out.join("\n"), "text/markdown");
  }

  exportNotes() {
    download(`${this.paper.id}-crawler-notes.json`, JSON.stringify({ paper: this.paper.meta.title, id: this.paper.id, notes: this.notes }, null, 2), "application/json");
  }
}

const clean = (t) => t.replace(KEY_RE, "").trim();
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
