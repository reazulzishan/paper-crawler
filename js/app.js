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
import { detect, loadPuter, PuterEngine, NanoEngine, WebEngine, WEB_MODELS } from "./ai.js";
import { reportHtml } from "./report-html.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MAX_TEXT = 4000; // small on-device models have small context windows

const LANDING = document.querySelector("#paper").innerHTML; // the start page, restored after an error
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
    fail(e);
  }
}

async function openArxiv(id) {
  showLoading(`arXiv ${id} আনা হচ্ছে…`);
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
  showLoading("PDF আনা হচ্ছে…");
  let r;
  try { r = await fetch(url); } catch {
    throw new Error("এই website অন্য সাইটকে PDF দিতে দেয় না। PDF-টা download করে এখানে টেনে আনুন।");
  }
  if (!r.ok) throw new Error(`PDF আনা গেল না (HTTP ${r.status})। Download করে টেনে আনুন।`);
  return openPdf(await r.arrayBuffer(), { id: url, url });
}

async function openPdf(buf, meta) {
  showLoading("PDF পড়া হচ্ছে…");
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
  buildMap(paper);
  showHint();

  if (!state.crawler) {
    state.crawler = new Crawler({
      canvas: $("#crawler"), paperEl, companion: true,
      onSection: (s) => { markCurrent(s.title); enqueue(jobFor(s)); },
    });
  }
  state.crawler.setPaper(paper);
  const abs = paper.sections.find((s) => s.isAbstract);
  if (abs) enqueue({ ...jobFor(abs), kind: "tldr" });
}

function status(t) { $("#meta").textContent = t; }

/** Show what went wrong; if no paper is open yet, bring the start page back. */
function fail(e) {
  status("⚠ " + e.message);
  toast("⚠ " + e.message, true);
  if (!state.paper) $("#paper").innerHTML = LANDING;
}

/** Grey placeholder lines while a paper downloads / is read. */
function showLoading(text) {
  status(text);
  $("#paper").innerHTML = `<div class="paper-loading" aria-label="${esc(text)}">${"<i></i>".repeat(9)}</div>`;
}

// ------------------------------------------------------------------ section map (tab "অংশসমূহ")
function buildMap(paper) {
  const list = paper.sections.filter((s) => s.title !== "Title" && !s.isReferences);
  $("#map-count").textContent = list.length;
  $("#map").innerHTML = list.map((s, i) => `<li class="${s.heading.tagName === "H3" ? "sub" : ""}" data-sec="${esc(s.title)}">
      <button data-i="${i}"><span class="st"></span><span>${esc(s.isAbstract ? "Abstract · TL;DR" : s.title)}</span></button></li>`).join("");
  $("#map").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    const s = list[+b.dataset.i];
    s.heading.scrollIntoView({ behavior: "smooth", block: "start" }); // the spider follows the reader
    enqueue(jobFor(s));
  }));
}
const mapItem = (title) => [...$("#map").children].find((li) => li.dataset.sec === title);
function setMapStatus(title, st) {
  const dot = mapItem(title)?.querySelector(".st");
  if (dot) { dot.className = "st " + st; dot.textContent = st === "done" ? "✓" : st === "warn" ? "!" : ""; }
}
function markCurrent(title) {
  [...$("#map").children].forEach((li) => li.classList.toggle("current", li.dataset.sec === title));
}

function showHint() {
  $("#hint").innerHTML = `<div class="hint"><span class="arrow">↓</span><span>Paper-টা নিচে scroll করে পড়ুন। Spider আপনার সাথে যাবে, আর যে অংশে থামবেন সেটার বাংলা ব্যাখ্যা এখানে আসবে।</span></div>`;
  const off = () => { if (scrollY > 200) { $("#hint").innerHTML = ""; removeEventListener("scroll", off); } };
  addEventListener("scroll", off, { passive: true });
}

function jobFor(s, kind) {
  return {
    kind: kind || (s.isAbstract ? "tldr" : "section"), section: s.title, isReferences: s.isReferences,
    text: sectionText(s, state.crawler?.walked, MAX_TEXT), paper: state.info, container: s.container,
  };
}

// ================================================================== AI setup
const savedEngine = () => { try { return localStorage.getItem("pc:engine"); } catch { return null; } };

/** Default: one button, instant Claude via Puter. Offline (on-device) AI sits behind a link. */
async function setupAI() {
  const box = $("#ai");
  box.innerHTML = `<div class="box connect">
      <h3>বাংলা ব্যাখ্যা চালু করুন</h3>
      <p>একবার free Puter account দিয়ে login করুন (Google দিয়েও হয়)। এরপর প্রতিটা অংশের ব্যাখ্যা সাথে সাথে আসবে।</p>
      <button class="btn-primary" id="connect">চালু করুন</button>
      <button class="link" id="offline-toggle">অথবা offline AI ব্যবহার করুন</button>
      <div id="offline" hidden></div>
      <div class="progress" hidden><i></i></div><p id="ai-msg" class="muted"></p>
    </div>`;
  $("#connect").onclick = () => startEngine("puter");
  $("#offline-toggle").onclick = () => { $("#offline").hidden = !$("#offline").hidden; if (!$("#offline").innerHTML) renderOffline(); };
  loadPuter().then(() => {
    // returning reader: connect silently
    if (PuterEngine.signedIn() && (savedEngine() || "puter") === "puter") startEngine("puter");
  }).catch(() => {});
  const kind = savedEngine();
  if (kind && kind !== "puter") startEngine(kind); // offline model already downloaded before: loads from cache
}

async function renderOffline() {
  const d = await detect();
  const opt = (engine, title, sub) => `<button class="ai-opt" data-engine="${engine}"><b>${title}</b><span>${sub}</span></button>`;
  const options = [];
  if (d.gpu) options.push(opt("big", WEB_MODELS.big.label, "Computer-এই চলে · প্রথমবার প্রায় 2.5 GB download"));
  if (d.nano !== "unavailable") options.push(opt("nano", "Chrome-এর built-in AI", "সবচেয়ে হালকা · ইংরেজি থেকে বাংলা অনুবাদ"));
  if (d.gpu) options.push(opt("small", WEB_MODELS.small.label, "দুর্বল computer-এর জন্য · প্রায় 1.3 GB"));
  $("#offline").innerHTML = `<p class="muted">Account লাগে না, paper কোথাও যায় না, internet ছাড়াও চলে। মান একটু কম।</p>` +
    (options.join("") || `<p class="muted">এই browser-এ offline AI চলে না।</p>`);
  $("#offline").querySelectorAll("[data-engine]").forEach((b) => (b.onclick = () => startEngine(b.dataset.engine)));
}

async function startEngine(kind) {
  const box = $("#ai");
  box.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const bar = box.querySelector(".progress"), fill = box.querySelector(".progress i"), msg = $("#ai-msg");
  if (bar && kind !== "puter") bar.hidden = false;
  if (msg && kind === "puter") msg.textContent = "Login window খুলছে…";
  const engine = kind === "puter" ? new PuterEngine() : kind === "nano" ? new NanoEngine() : new WebEngine(kind);
  try {
    await engine.init((label, frac) => {
      if (fill) fill.style.width = Math.round(frac * 100) + "%";
      if (msg) msg.textContent = `${label} download/load হচ্ছে… ${Math.round(frac * 100)}% (প্রথমবার কয়েক মিনিট লাগতে পারে)`;
    });
    state.engine = engine;
    try { localStorage.setItem("pc:engine", kind); } catch { /* private mode */ }
    box.innerHTML = `<div class="ai-ready">বাংলা ব্যাখ্যা চালু · ${esc(engine.name)}</div>`;
    if (!state.paper) toast("চালু হয়েছে। এখন একটা paper খুলুন।");
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
  $("#now").textContent = "🕷 " + (job.kind === "tldr" ? "TL;DR: পুরো paper এক নজরে" : job.section);
  state.queue = state.queue.filter((j) => j.kind !== "section" || job.kind !== "section"); // newest section only
  job.kind === "selection" ? state.queue.unshift(job) : state.queue.push(job);
  pump();
}

async function pump() {
  if (state.busy || !state.queue.length || !state.engine) return; // waits for "চালু করুন"
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
  if (state.engine && job.kind !== "selection") setMapStatus(job.section, "busy");
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
  if (job.kind !== "selection") {
    const ok = entry.checks?.evidenceOk && !entry.checks.missingNumbers.length;
    setMapStatus(job.section, entry.ai ? (ok ? "done" : "warn") : "");
  }
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
  const kind = entry.kind === "tldr" ? "TL;DR" : entry.kind === "selection" ? "নির্বাচিত অংশ" : "অংশ";
  const title = entry.kind === "tldr" ? "পুরো paper এক নজরে" : entry.section;
  card.innerHTML = `<h4><span>${kind}</span><span class="sec">${esc(title)}</span><span class="tag">${{ easy: "সহজ", mid: "মাঝারি", deep: "গভীর" }[entry.level]}</span></h4>
    <p class="bn ${state.engine ? "thinking" : ""}">${state.engine ? "spider পড়ছে, AI বাংলায় লিখছে" : ""}</p>
    ${state.engine ? `<div class="skeleton"><i></i><i></i><i></i></div>` : ""}`;
  $("#history").prepend(card);
  return card;
}

function renderCard(card, entry) {
  card.classList.remove("live");
  card.querySelector(".skeleton")?.remove();
  const bn = card.querySelector(".bn");
  bn.classList.remove("thinking");
  bn.textContent = entry.bn || entry.ai?.explanation || "";
  if (entry.error) bn.insertAdjacentHTML("afterend", `<div class="checks"><span class="chip warn">⚠ AI উত্তর দিতে পারেনি: ${esc(entry.error)}</span></div>`);
  if (entry.ai?.explanation && entry.bn && entry.ai.explanation !== entry.bn) {
    card.insertAdjacentHTML("beforeend", `<details class="en"><summary>English-এ দেখুন</summary><p>${esc(entry.ai.explanation)}</p></details>`);
  }
  const c = entry.checks;
  if (c) {
    const chips = document.createElement("div");
    chips.className = "checks";
    chips.innerHTML =
      (c.evidenceOk ? `<span class="chip ok" title="AI যে বাক্যের ভিত্তিতে বলছে, সেটা paper-এ হুবহু পাওয়া গেছে">✅ প্রমাণ মিলেছে</span>`
        : `<span class="chip warn" title="AI-এর দেওয়া প্রমাণ বাক্য paper-এ হুবহু নেই">⚠️ প্রমাণ মেলেনি, নিজে যাচাই করুন</span>`) +
      (c.numbers.length ? (c.missingNumbers.length
        ? `<span class="chip warn">⚠️ সংখ্যা মেলেনি: ${esc(c.missingNumbers.join(", "))}</span>`
        : `<span class="chip ok">✅ সংখ্যা মিলেছে: ${esc(c.numbers.join(", "))}</span>`) : "");
    card.append(chips);
    if (c.evidenceOk) {
      const ev = document.createElement("blockquote");
      ev.className = "evidence";
      ev.innerHTML = `“${esc(entry.ai.evidence)}”<button>🕷 paper-এ দেখাও</button>`;
      ev.querySelector("button").onclick = () => point(entry.ai.evidence, entry.job.container);
      card.append(ev);
    }
  }
  if (entry.bn) {
    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.innerHTML = `<button data-act="copy">Copy</button>`;
    actions.querySelector("[data-act=copy]").onclick = async (e) => {
      try { await navigator.clipboard.writeText(entry.bn + "\n\n" + (state.info?.title || "")); e.target.textContent = "Copied ✓"; }
      catch { e.target.textContent = "Copy হয়নি"; }
    };
    card.append(actions);
  }
}

function renderGlossary() {
  $("#term-count").textContent = state.glossary.size;
  if (!state.glossary.size) return;
  const items = [...state.glossary.values()].sort((a, b) => a.term.localeCompare(b.term));
  $("#glossary").innerHTML = items.map((t) =>
    `<div class="term"><b>${esc(t.term)}</b><small>${esc(t.section)}</small><p>${esc(t.bn || t.meaning)}</p></div>`).join("");
}

// ================================================================== full analysis + report
/** Explain every section (skipping ones already done). Resolves when finished. */
async function runAnalysis() {
  if (!state.paper) { toast("আগে একটা paper খুলুন।"); return false; }
  if (!state.engine) { askToConnect(); return false; }
  if (state.analysing) return state.analysing;
  state.analysing = (async () => {
    const sections = state.paper.sections.filter((s) => s.title !== "Title" && !s.isReferences);
    $("#all").disabled = true;
    while (state.busy) await new Promise((r) => setTimeout(r, 300));
    state.busy = true; // hold the normal queue
    const prog = $("#progress");
    prog.hidden = false;
    try {
      for (const [i, s] of sections.entries()) {
        prog.innerHTML = `পুরো paper বিশ্লেষণ · ${i + 1}/${sections.length} · ${esc(s.title)}<div class="bar"><i style="width:${Math.round((i / sections.length) * 100)}%"></i></div>`;
        wrapWords(s.container); // so the spider can point there later
        const job = { ...jobFor(s), level: state.level, order: i, quiet: true };
        job.id = [job.kind, job.section, job.level, ""].join("|");
        const old = state.entries.find((e) => e.id === job.id && e.ai);
        if (old) { old.order = i; continue; }
        state.entries = state.entries.filter((e) => e.id !== job.id); // drop an earlier failed try
        await explain(job);
      }
      prog.innerHTML = `বিশ্লেষণ শেষ · ${sections.length}টা অংশ, ${state.glossary.size}টা কঠিন শব্দ<div class="bar"><i style="width:100%"></i></div>`;
      return true;
    } finally {
      state.busy = false;
      state.analysing = null;
      $("#all").disabled = false;
      pump();
    }
  })();
  return state.analysing;
}
$("#all").onclick = () => runAnalysis();

/** Point the reader at the connect button (used when an action needs the AI). */
function askToConnect() {
  showTab("explain");
  $("#panel").classList.add("expanded");
  const c = $("#ai .connect");
  c?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  c?.classList.remove("pulse"); void c?.offsetWidth; c?.classList.add("pulse");
  toast("আগে \"চালু করুন\" চাপুন। এক click-এ free login, তারপর সব কাজ করবে।");
}

// One click does it all: explain whatever is missing, then download the report.
$("#export").onclick = async () => {
  if (!state.paper) return toast("আগে একটা paper খুলুন।");
  if (!state.engine) return askToConnect();
  const btn = $("#export");
  btn.disabled = true;
  btn.textContent = "চলছে…";
  try {
    if (!(await runAnalysis())) return;
    btn.textContent = "PDF…";
    const done = state.entries.filter((e) => e.ai).map(({ card, job, ...e }) => e);
    const host = $("#report-host");
    host.innerHTML = `<div class="report">${reportHtml({
      paper: state.info, level: state.level, date: new Date().toISOString().slice(0, 10), ai: state.engine?.name,
      entries: done.sort((a, b) => (a.kind === "tldr" ? -1 : b.kind === "tldr" ? 1 : a.order - b.order)),
      glossary: [...state.glossary.values()].sort((a, b) => a.term.localeCompare(b.term)),
    })}</div>`;
    if (!window.html2pdf) await loadScript("vendor/html2pdf.bundle.min.js");
    const name = (state.info.title || "paper").replace(/[^\w\- ]+/g, "").trim().slice(0, 60).replace(/\s+/g, "-") + "-bangla-breakdown.pdf";
    // The browser draws the Bangla (so conjuncts are shaped right), then it's saved as a PDF.
    // html2canvas captures relative to the scroll position: render from the top, then put the reader back.
    const y = scrollY;
    scrollTo(0, 0);
    try {
      await window.html2pdf().set({
        margin: [12, 10, 14, 10], filename: name,
        image: { type: "jpeg", quality: 0.92 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff", scrollX: 0, scrollY: 0, windowWidth: 900 },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["css", "legacy"], avoid: ["section", "tr"] },
      }).from(host.firstElementChild).save();
    } finally {
      scrollTo(0, y);
    }
    host.innerHTML = "";
    toast("PDF download হয়েছে: " + name);
  } catch (e) {
    console.error(e);
    toast("PDF বানানো গেল না: " + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "PDF report";
  }
};

function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement("script");
    Object.assign(s, { src, onload: ok, onerror: () => fail(new Error("could not load " + src)) });
    document.head.append(s);
  });
}

function toast(text, warn = /আগে|গেল না|⚠/.test(text)) {
  const d = document.createElement("div");
  d.className = "toast" + (warn ? " warn" : "");
  d.textContent = text;
  $("#toasts").append(d);
  setTimeout(() => d.remove(), 5000);
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
  if (!state.engine) return askToConnect();
  const r = sel.getRangeAt(0).getBoundingClientRect();
  state.crawler.goTo(r.left + scrollX + Math.min(r.width / 2, 40), r.top + scrollY + r.height / 2);
  const s = state.crawler.currentSection() || state.paper.sections[0];
  enqueue({ ...jobFor(s, "selection"), text });
}
$("#sel").onclick = explainSelection;
$("#pause").onclick = () => { if (state.crawler) { state.crawler.paused = !state.crawler.paused; $("#pause").textContent = state.crawler.paused ? "▶" : "⏸"; } };
$("#clear").onclick = () => state.crawler?.clearMarkup();
function showTab(tab) {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x.dataset.tab === tab));
  document.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== tab));
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea") || e.metaKey || e.ctrlKey) return;
  if (e.key.toLowerCase() === "e") explainSelection();
});

$("#open-form").onsubmit = (e) => { e.preventDefault(); openInput($("#open-input").value); };
$("#file").onchange = async (e) => {
  const f = e.target.files[0];
  if (f) openPdf(await f.arrayBuffer(), { id: "file:" + f.name + ":" + f.size, url: null }).catch(fail);
};
// Dragging a file anywhere shows a big drop zone.
let dragDepth = 0;
addEventListener("dragenter", (e) => { if ([...e.dataTransfer.types].includes("Files")) { dragDepth++; $("#drop-overlay").hidden = false; } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop-overlay").hidden = true; } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#drop-overlay").hidden = true;
  const f = [...e.dataTransfer.files].find((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (f) openPdf(await f.arrayBuffer(), { id: "file:" + f.name + ":" + f.size, url: null }).catch(fail);
});
$("#paper").addEventListener("click", (e) => {
  const b = e.target.closest("[data-paper]");
  if (b) openArxiv(b.dataset.paper).catch(fail);
});
$("#handle").onclick = () => $("#panel").classList.toggle("expanded"); // phones: pull the sheet up/down

// ================================================================== boot
if (new URLSearchParams(location.search).has("debug")) window.__app = state; // for testing
let saved = null;
try { saved = localStorage.getItem("pc:level"); } catch { /* private mode */ }
setLevel(saved || "easy");
setupAI();
const start = location.hash.slice(1).replace(/-(?=\d{4,5}(v\d+)?$)/, ".");
if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(start)) openArxiv(start).catch(fail);
