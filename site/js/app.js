// app.js - the Paper Crawler website: any paper, explained in Bangla, free.
//
// 1. Open a paper: arXiv link/ID (fetched straight from arxiv.org), a PDF link,
//    or a PDF file the reader drops in. PDFs become readable HTML (pdf-reader.js).
// 2. The spider (crawler.js) reads along wherever the reader scrolls.
// 3. When it settles in a section, the best free AI on this device explains it
//    in Bangla (ai.js), and code checks the answer against the paper (checks.js).
// 4. "Full analysis" explains every section + builds a glossary; "PDF report"
//    downloads all of it with the paper's DOI.

import { fromPage, findPhrase, sectionText, wrapWords } from "./loader.js";
import { Crawler } from "./crawler.js";
import { pdfToArticle } from "./pdf-reader.js";
import { verify } from "./checks.js";
import { detect, NanoEngine, WebEngine, WEB_MODELS, handoffPrompt, handoffUrl } from "./ai.js";
import { reportHtml } from "./report-html.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MAX_TEXT = 4000; // small on-device models have small context windows

const state = {
  level: "easy", engine: null, busy: false, queue: [], entries: [], glossary: new Map(),
  paper: null, info: null, crawler: null,
};

// ================================================================== opening papers
const ARXIV = /(?:arxiv\.org\/(?:abs|pdf|html)\/)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(?:\.pdf)?\/?$/i;

async function openInput(raw) {
  const s = raw.trim();
  if (!s) return;
  const m = ARXIV.exec(s.replace(/[?#].*$/, ""));
  try {
    if (m) return await openArxiv(m[1]);
    if (/^https?:\/\//.test(s)) return await openPdfUrl(s);
    status("এটা arXiv link/ID বা PDF link মনে হচ্ছে না।");
  } catch (e) {
    status("⚠ " + e.message);
  }
}

async function openArxiv(id) {
  status(`arXiv ${id} আনা হচ্ছে…`);
  const doi = "10.48550/arXiv." + id.replace(/v\d+$/, "");
  const r = await fetch(`https://arxiv.org/html/${id}`).catch(() => null);
  const html = r?.ok ? await r.text() : "";
  if (html.includes("ltx_document")) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const article = doc.querySelector("article.ltx_document");
    article.querySelectorAll("script, style, link, .ltx_page_footer, .package-alerts, .ltx_ERROR, button, nav").forEach((n) => n.remove());
    // resolve figures and links against arXiv, exactly like the browser would
    article.querySelectorAll("img[src]").forEach((img) => (img.src = new URL(img.getAttribute("src"), r.url).href));
    article.querySelectorAll("a[href]").forEach((a) => {
      if (!a.getAttribute("href").startsWith("#")) { a.href = new URL(a.getAttribute("href"), r.url).href; a.target = "_blank"; }
    });
    return mount(document.adoptNode(article), { id, url: `https://arxiv.org/abs/${id}`, doi });
  }
  // No HTML version (older or unusual papers): read the PDF instead.
  status("HTML version নেই, PDF পড়া হচ্ছে…");
  const pr = await fetch(`https://arxiv.org/pdf/${id}`);
  if (!pr.ok) throw new Error(`arXiv-এ ${id} পাওয়া যায়নি (HTTP ${pr.status})।`);
  return openPdf(await pr.arrayBuffer(), { id, url: `https://arxiv.org/abs/${id}`, doi });
}

async function openPdfUrl(url) {
  status("PDF আনা হচ্ছে…");
  let r;
  try { r = await fetch(url); } catch {
    throw new Error("এই website অন্য সাইটকে PDF দিতে দেয় না। PDF-টা download করে এখানে টেনে আনুন।");
  }
  if (!r.ok) throw new Error(`PDF আনা গেল না (HTTP ${r.status})। Download করে টেনে আনুন।`);
  return openPdf(await r.arrayBuffer(), { id: url, url });
}

async function openPdf(buf, meta) {
  const r = await pdfToArticle(buf, (p, n) => status(`PDF পড়া হচ্ছে… পৃষ্ঠা ${p}/${n}`));
  const article = new DOMParser().parseFromString(r.html, "text/html").querySelector("article");
  return mount(document.adoptNode(article), meta, `${r.pages} পৃষ্ঠার PDF · equation ও ছবি মূল PDF-এ দেখুন`);
}

/** Show the paper, start the spider, reset the panel. */
function mount(article, meta, note) {
  const paperEl = $("#paper");
  paperEl.replaceChildren(article);
  scrollTo(0, 0);
  const paper = fromPage(article);
  paper.id = meta.id;
  const doi = meta.doi
    || (/\b10\.\d{4,9}\/[^\s"<>]*[^\s"<>.,;)\]]/.exec(article.textContent.slice(0, 6000)) || [])[0] || null;
  state.paper = paper;
  state.info = {
    title: paper.meta.title, url: meta.url, doi,
    authors: [...article.querySelectorAll(".ltx_personname")].map((e) => e.firstChild?.textContent.trim()).filter(Boolean).slice(0, 15).join(", ")
      || (article.querySelector(".ltx_authors")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
  };
  $("#meta").textContent = `${paper.meta.title}${doi ? " · DOI " + doi : ""}${note ? " · " + note : ""}`;
  document.title = paper.meta.title + " · Paper Crawler";
  if (meta.url?.startsWith("https://arxiv.org/abs/")) history.replaceState(null, "", "#" + meta.id.replace(/\W/g, "-"));

  // reset the panel for the new paper
  Object.assign(state, { queue: [], entries: [] });
  state.glossary.clear();
  $("#history").replaceChildren();
  renderGlossary();

  if (!state.crawler) {
    state.crawler = new Crawler({ canvas: $("#crawler"), paperEl, companion: true, onSection: (s) => enqueue(jobFor(s)) });
  }
  state.crawler.setPaper(paper);
  const abs = paper.sections.find((s) => s.isAbstract);
  if (abs) enqueue({ ...jobFor(abs), kind: "tldr" });
}

function status(t) { $("#meta").textContent = t; }

function jobFor(s, kind) {
  return {
    kind: kind || (s.isAbstract ? "tldr" : "section"), section: s.title, isReferences: s.isReferences,
    text: sectionText(s, state.crawler?.walked, MAX_TEXT), paper: state.info, container: s.container,
  };
}

// ================================================================== AI setup
async function setupAI() {
  const box = $("#ai");
  const d = await detect();
  const nanoOk = d.nano !== "unavailable";
  const options = [];
  if (nanoOk) options.push(`<button class="primary" data-engine="nano">⚡ Chrome-এর built-in AI চালু করুন</button><p class="muted">সবচেয়ে হালকা। Chrome একবার model download করবে, তারপর offline চলবে।</p>`);
  if (d.gpu) {
    options.push(`<button class="${nanoOk ? "" : "primary"}" data-engine="big">🧠 ${WEB_MODELS.big.label} চালু করুন</button><p class="muted">${WEB_MODELS.big.note}। সরাসরি বাংলায় লেখে।</p>`);
    options.push(`<button data-engine="small">🪶 ${WEB_MODELS.small.label} চালু করুন</button><p class="muted">${WEB_MODELS.small.note}</p>`);
  }
  box.innerHTML = `<div class="box"><p><b>বাংলা ব্যাখ্যার জন্য একটা free AI বেছে নিন</b> (একবার download, তারপর আপনার computer-এই চলবে):</p>
    ${options.join("") || `<p>এই browser বা computer-এ কোনো AI চালানো যায় না।</p>`}
    <p class="muted">AI ছাড়াও প্রতিটা অংশের নিচে <b>Claude / ChatGPT</b> বোতাম থাকবে: আপনার free account-এ এক click-এ বাংলা ব্যাখ্যা।</p>
    <div class="progress" hidden><i></i></div><p id="ai-msg" class="muted"></p></div>`;
  box.querySelectorAll("[data-engine]").forEach((b) => (b.onclick = () => startEngine(b.dataset.engine)));
  if (d.nano === "available") startEngine("nano"); // already downloaded earlier: no click needed
}

async function startEngine(kind) {
  const box = $("#ai");
  box.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const bar = box.querySelector(".progress"), fill = box.querySelector(".progress i"), msg = $("#ai-msg");
  if (bar) bar.hidden = false;
  const engine = kind === "nano" ? new NanoEngine() : new WebEngine(kind);
  try {
    await engine.init((label, frac) => {
      if (fill) fill.style.width = Math.round(frac * 100) + "%";
      if (msg) msg.textContent = `${label} download/load হচ্ছে… ${Math.round(frac * 100)}% (প্রথমবার কয়েক মিনিট লাগতে পারে)`;
    });
    state.engine = engine;
    box.innerHTML = `<p class="muted">✓ AI: ${esc(engine.name)}</p>`;
    // sections shown before the AI was ready get a real explanation now
    const redo = state.entries.filter((e) => !e.ai && !e.error);
    state.entries = state.entries.filter((e) => !redo.includes(e));
    for (const e of redo) { e.card.remove(); enqueue(e.job); }
    pump();
  } catch (e) {
    console.error(e);
    if (msg) msg.textContent = "⚠ চালু করা গেল না: " + e.message + (kind === "big" ? " · হালকা model-টা চেষ্টা করুন।" : "");
    box.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}

// ================================================================== explaining
function enqueue(job) {
  if (!job?.text?.trim() || job.isReferences || job.section === "Title") return;
  job.level = state.level;
  job.id = [job.kind, job.section, job.level, job.kind === "selection" ? job.text.slice(0, 60) : ""].join("|");
  if (state.entries.some((e) => e.id === job.id) || state.queue.some((j) => j.id === job.id)) return;
  $("#now").textContent = "▸ " + (job.kind === "tldr" ? "TL;DR" : job.section);
  state.queue = state.queue.filter((j) => j.kind !== "section" || job.kind !== "section"); // newest section only
  job.kind === "selection" ? state.queue.unshift(job) : state.queue.push(job);
  pump();
}

async function pump() {
  if (state.busy || !state.queue.length) return;
  state.busy = true;
  const job = state.queue.shift();
  try { await explain(job); } catch (e) { console.error(e); }
  state.busy = false;
  pump();
}

const cacheGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const cacheSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };

async function explain(job) {
  const entry = { id: job.id, kind: job.kind, section: job.section, level: job.level, order: job.order ?? 999, job };
  state.entries.push(entry);
  const card = makeCard(entry);
  entry.card = card;
  if (state.engine) {
    const key = "pc:" + (state.paper?.id || "") + "|" + job.id + "|" + state.engine.name;
    try {
      entry.ai = cacheGet(key) || await state.engine.explain(job);
      cacheSet(key, entry.ai);
      entry.bn = entry.ai.bn;
      entry.checks = verify(entry.ai, job.text);
      // keep only terms that really occur in this section (checked by code)
      const src = job.text.toLowerCase();
      entry.terms = (entry.ai.terms || []).filter((t) => t.term && src.includes(t.term.toLowerCase().trim()));
      for (const t of entry.terms) {
        const k = t.term.toLowerCase().trim();
        if (!state.glossary.has(k)) state.glossary.set(k, { ...t, section: job.section });
      }
      renderGlossary();
    } catch (e) {
      entry.error = e.message;
    }
  }
  renderCard(card, entry);
  if (job.quiet || !entry.checks) return;
  // let the spider show where the answer comes from
  const phrase = entry.checks.evidenceOk ? entry.ai.evidence : entry.checks.keyOk ? entry.ai.key : null;
  if (phrase) point(phrase, job.container);
}

function point(phrase, container) {
  const spans = findPhrase(phrase, state.paper.article, container);
  if (spans) state.crawler.pointAt(spans, () => spans.forEach((s) => state.crawler.addClass(s, "m-key")));
  return !!spans;
}

// ================================================================== rendering
function makeCard(entry) {
  const card = document.createElement("article");
  card.className = "card live";
  const title = entry.kind === "tldr" ? "TL;DR · পুরো paper এক নজরে" : entry.kind === "selection" ? "নির্বাচিত অংশ · " + entry.section : entry.section;
  card.innerHTML = `<h4>${esc(title)}<span class="tag">${{ easy: "সহজ", mid: "মাঝারি", deep: "গভীর" }[entry.level]}</span></h4>
    <p class="bn ${state.engine ? "thinking" : ""}">${state.engine ? "ভাবছে…" : ""}</p>`;
  $("#history").prepend(card);
  return card;
}

function renderCard(card, entry) {
  card.classList.remove("live");
  const bn = card.querySelector(".bn");
  bn.classList.remove("thinking");
  bn.textContent = entry.bn || entry.ai?.explanation || (entry.error ? "" : state.engine ? "" : "AI চালু না থাকলে নিচের বোতাম দিয়ে আপনার free Claude/ChatGPT-এ বুঝে নিন।");
  if (entry.error) bn.insertAdjacentHTML("afterend", `<p class="check warn">⚠ AI উত্তর দিতে পারেনি: ${esc(entry.error)}</p>`);
  if (entry.ai?.explanation && entry.bn && entry.ai.explanation !== entry.bn) {
    card.insertAdjacentHTML("beforeend", `<details class="en"><summary>English</summary><p>${esc(entry.ai.explanation)}</p></details>`);
  }
  const c = entry.checks;
  if (c) {
    const div = document.createElement("div");
    div.className = "checks";
    div.innerHTML =
      (c.evidenceOk
        ? `<div class="check ok">✅ প্রমাণ বাক্যটা paper-এ হুবহু আছে<q>${esc(entry.ai.evidence)}</q><button data-act="point">paper-এ দেখাও</button></div>`
        : `<div class="check warn">⚠️ AI-এর দেওয়া প্রমাণ বাক্য paper-এ হুবহু মেলেনি। এই ব্যাখ্যা সাবধানে পড়ুন।</div>`) +
      (c.numbers.length
        ? c.missingNumbers.length
          ? `<div class="check warn">⚠️ এই সংখ্যাগুলো এই অংশে পাওয়া যায়নি: <b>${esc(c.missingNumbers.join(", "))}</b></div>`
          : `<div class="check ok">✅ ব্যাখ্যার সব সংখ্যা (${esc(c.numbers.join(", "))}) paper-এ আছে</div>`
        : "");
    div.querySelector("[data-act=point]")?.addEventListener("click", () => point(entry.ai.evidence, entry.job.container));
    card.append(div);
  }
  // Always offer the strongest free option: the reader's own Claude / ChatGPT.
  const prompt = handoffPrompt(entry.job);
  const ask = document.createElement("div");
  ask.className = "row ask";
  ask.innerHTML = `<span class="muted">আরও ভালো ব্যাখ্যা:</span>
    <a class="btn" target="_blank" rel="noopener" href="${handoffUrl.claude(prompt)}">Claude-এ বুঝুন</a>
    <a class="btn" target="_blank" rel="noopener" href="${handoffUrl.chatgpt(prompt)}">ChatGPT-এ বুঝুন</a>
    <button data-act="copy">prompt copy</button>`;
  ask.querySelector("[data-act=copy]").onclick = async (e) => {
    try { await navigator.clipboard.writeText(prompt); e.target.textContent = "copied ✓"; } catch { e.target.textContent = "copy হয়নি"; }
  };
  card.append(ask);
}

function renderGlossary() {
  $("#term-count").textContent = state.glossary.size;
  if (!state.glossary.size) return;
  const items = [...state.glossary.values()].sort((a, b) => a.term.localeCompare(b.term));
  $("#glossary").innerHTML = items.map((t) =>
    `<div class="term"><b>${esc(t.term)}</b> <small>${esc(t.section)}</small><p>${esc(t.bn || t.meaning)}</p></div>`).join("");
}

// ================================================================== full analysis + report
$("#all").onclick = async () => {
  if (!state.paper) return toast("আগে একটা paper খুলুন।");
  if (!state.engine) return toast("আগে উপরের বোতাম দিয়ে একটা AI চালু করুন।");
  const sections = state.paper.sections.filter((s) => s.title !== "Title" && !s.isReferences);
  $("#all").disabled = true;
  while (state.busy) await new Promise((r) => setTimeout(r, 300));
  state.busy = true; // hold the normal queue
  const prog = $("#progress");
  prog.hidden = false;
  try {
    for (const [i, s] of sections.entries()) {
      prog.textContent = `📑 বিশ্লেষণ চলছে… ${i + 1}/${sections.length}: ${s.title}`;
      wrapWords(s.container); // so the spider can point there later
      const job = { ...jobFor(s), level: state.level, order: i, quiet: true };
      job.id = [job.kind, job.section, job.level, ""].join("|");
      const old = state.entries.find((e) => e.id === job.id);
      if (old) { old.order = i; continue; }
      await explain(job);
    }
    prog.textContent = `✅ পুরো paper বিশ্লেষণ শেষ (${sections.length}টা অংশ)। "⤓ PDF report" চাপুন।`;
  } finally {
    state.busy = false;
    $("#all").disabled = false;
    pump();
  }
};

$("#export").onclick = async () => {
  const done = state.entries.filter((e) => e.ai).map(({ card, job, ...e }) => e);
  if (!done.length) return toast("আগে \"📑 পুরো paper বিশ্লেষণ\" চাপুন, তারপর PDF নামান।");
  const btn = $("#export");
  btn.disabled = true;
  btn.textContent = "PDF বানানো হচ্ছে…";
  try {
    const host = $("#report-host");
    host.innerHTML = `<div class="report">${reportHtml({
      paper: state.info, level: state.level, date: new Date().toISOString().slice(0, 10), ai: state.engine?.name,
      entries: done.sort((a, b) => (a.kind === "tldr" ? -1 : b.kind === "tldr" ? 1 : a.order - b.order)),
      glossary: [...state.glossary.values()].sort((a, b) => a.term.localeCompare(b.term)),
    })}</div>`;
    if (!window.html2pdf) await loadScript("vendor/html2pdf.bundle.min.js");
    const name = (state.info.title || "paper").replace(/[^\w\- ]+/g, "").trim().slice(0, 60).replace(/\s+/g, "-") + "-bangla-breakdown.pdf";
    // The browser draws the Bangla (so conjuncts are shaped right), then it's saved as a PDF.
    await window.html2pdf().set({
      margin: [12, 10, 14, 10], filename: name,
      image: { type: "jpeg", quality: 0.92 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"], avoid: ["section", "tr"] },
    }).from(host.firstElementChild).save();
    host.innerHTML = "";
  } catch (e) {
    console.error(e);
    toast("PDF বানানো গেল না: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "⤓ PDF report";
  }
};

function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement("script");
    Object.assign(s, { src, onload: ok, onerror: () => fail(new Error("could not load " + src)) });
    document.head.append(s);
  });
}

function toast(text) {
  const d = document.createElement("div");
  d.className = "box warn";
  d.textContent = text;
  $("#history").prepend(d);
  setTimeout(() => d.remove(), 6000);
}

// ================================================================== controls
function setLevel(level) {
  state.level = level;
  document.querySelectorAll("#levels [data-level]").forEach((b) => b.classList.toggle("on", b.dataset.level === level));
  try { localStorage.setItem("pc:level", level); } catch { /* private mode */ }
  const s = state.crawler?.currentSection();
  if (s && state.paper) enqueue(jobFor(s));
}
document.querySelectorAll("#levels [data-level]").forEach((b) => (b.onclick = () => setLevel(b.dataset.level)));

function explainSelection() {
  const sel = getSelection();
  const text = String(sel).trim().slice(0, MAX_TEXT);
  if (!text || !state.paper) return toast("আগে paper-এ কিছু লেখা mouse দিয়ে select করুন।");
  const r = sel.getRangeAt(0).getBoundingClientRect();
  state.crawler.goTo(r.left + scrollX + Math.min(r.width / 2, 40), r.top + scrollY + r.height / 2);
  const s = state.crawler.currentSection() || state.paper.sections[0];
  enqueue({ ...jobFor(s, "selection"), text });
}
$("#sel").onclick = explainSelection;
$("#pause").onclick = () => { if (state.crawler) { state.crawler.paused = !state.crawler.paused; $("#pause").textContent = state.crawler.paused ? "▶" : "⏸"; } };
$("#clear").onclick = () => state.crawler?.clearMarkup();
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
}));
addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea") || e.metaKey || e.ctrlKey) return;
  if (e.key.toLowerCase() === "e") explainSelection();
});

$("#open-form").onsubmit = (e) => { e.preventDefault(); openInput($("#open-input").value); };
$("#file").onchange = async (e) => {
  const f = e.target.files[0];
  if (f) openPdf(await f.arrayBuffer(), { id: "file:" + f.name + ":" + f.size, url: null }).catch((err) => status("⚠ " + err.message));
};
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (f) openPdf(await f.arrayBuffer(), { id: "file:" + f.name + ":" + f.size, url: null }).catch((err) => status("⚠ " + err.message));
});
document.querySelectorAll("[data-paper]").forEach((b) => (b.onclick = () => openArxiv(b.dataset.paper).catch((e) => status("⚠ " + e.message))));

// ================================================================== boot
if (new URLSearchParams(location.search).has("debug")) window.__app = state; // for testing
let saved = null;
try { saved = localStorage.getItem("pc:level"); } catch { /* private mode */ }
setLevel(saved || "easy");
setupAI();
const start = location.hash.slice(1).replace(/-(?=\d{4,5}(v\d+)?$)/, ".");
if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(start)) openArxiv(start).catch((e) => status("⚠ " + e.message));
