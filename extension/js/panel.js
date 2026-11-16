// panel.js - the side panel: free on-device AI that explains each section
// in simple English (Gemini Nano, built into Chrome), translates it to Bangla
// (Chrome's built-in translator), and checks the answer against the paper.
//
// Nothing leaves the computer: no server, no key, no account.

import { verify, protect, restore } from "./checks.js";

const $ = (s) => document.querySelector(s);
const LEVELS = {
  easy: "a complete beginner (first-year university student). Use everyday words and one simple analogy",
  mid: "a computer-science student who knows basic machine learning",
  deep: "a machine-learning researcher. Be precise and technical",
};
const LANG = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };
const SCHEMA = {
  type: "object",
  properties: {
    explanation: { type: "string" }, evidence: { type: "string" }, key: { type: "string" },
    terms: {
      type: "array", maxItems: 3,
      items: { type: "object", properties: { term: { type: "string" }, meaning: { type: "string" } }, required: ["term", "meaning"], additionalProperties: false },
    },
  },
  required: ["explanation", "evidence", "key", "terms"],
  additionalProperties: false,
};
const SYSTEM = "You are a careful teaching assistant who explains machine-learning research papers to students. " +
  "You never invent facts or numbers: everything you say must come from the text you are given.";

const state = {
  level: "easy", showEn: false, tabId: null, paperUrl: null, paper: null,
  lm: null, tr: null, busy: false, queue: [], entries: [], glossary: new Map(),
};

// ------------------------------------------------------------------ talking to the page
/** Message the paper tab: content script on arXiv, or our PDF reader page (broadcast, tagged). */
async function toTab(msg) {
  if (state.tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(state.tabId, msg);
  } catch {
    return chrome.runtime.sendMessage({ ...msg, tabId: state.tabId }).catch(() => null);
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "section" && sender.tab?.id === state.tabId) enqueue(msg);
});
chrome.tabs.onActivated.addListener(() => refreshTab());
chrome.tabs.onUpdated.addListener((id, info) => { if (id === state.tabId && info.status === "complete") setTimeout(refreshTab, 800); });

async function refreshTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id ?? null;
  const here = await toTab({ type: "current" });
  showPdfHelp(tab, !!here);
  if (!here) { $("#now").textContent = "এই পাতায় কোনো paper পাওয়া যায়নি"; return; }
  if (here.current?.paper.url !== state.paperUrl) {
    state.paperUrl = here.current?.paper.url;
    state.paper = here.current?.paper;
    state.entries = [];
    state.queue = [];
    state.glossary.clear();
    $("#history").replaceChildren();
    $("#glossary").replaceChildren();
  }
  if (here.abstract) enqueue({ ...here.abstract, kind: "tldr" });
  if (here.current && !here.current.isAbstract) enqueue(here.current);
}

// ------------------------------------------------------------------ "any PDF" helper
function showPdfHelp(tab, hasPaper) {
  const box = $("#pdf");
  const url = tab?.url || "";
  const viewer = chrome.runtime.getURL("viewer.html");
  const arxiv = /arxiv\.org\/(?:abs|pdf)\/([\w.\-/]+?)(?:v\d+)?(?:\.pdf)?$/.exec(url);
  const isPdf = /\.pdf($|[?#])/i.test(url) || /\/pdf\//.test(url);
  box.hidden = hasPaper;
  if (hasPaper) return;
  box.innerHTML = "";
  const add = (html) => box.insertAdjacentHTML("beforeend", html);
  if (arxiv) {
    add(`<div class="box"><p>এটা arXiv paper। HTML version-এ খুললে equation আর ছবিসহ সবচেয়ে ভালো কাজ করে।</p><button class="primary" id="go-html">HTML version-এ খুলুন</button></div>`);
    $("#go-html").onclick = () => chrome.tabs.update(tab.id, { url: `https://arxiv.org/html/${arxiv[1]}` });
  }
  const offerPdf = (pdfUrl, doi, label) => {
    add(`<div class="box"><p>${label}</p><button class="primary" data-pdf>এই PDF Paper Crawler-এ খুলুন</button></div>`);
    box.lastElementChild.querySelector("[data-pdf]").onclick = async () => {
      const origin = new URL(pdfUrl).origin + "/*";
      // Must be the first thing in the click (Chrome asks the user once per website).
      const ok = pdfUrl.startsWith("file:") || await chrome.permissions.request({ origins: [origin] }).catch(() => false);
      if (!ok) return alertBox("অনুমতি না দিলে PDF-টা আনা যায় না। PDF download করে নিচের বোতাম দিয়ে খুলুন।");
      chrome.tabs.update(tab.id, { url: viewer + "?file=" + encodeURIComponent(pdfUrl) + (doi ? "&doi=" + encodeURIComponent(doi) : "") });
    };
  };
  if (isPdf) offerPdf(url, null, "এই PDF-টা Paper Crawler-এ খুলবেন? (একবার এই website-এর অনুমতি চাইবে)");
  else if (!arxiv && /^https?:/.test(url)) {
    // Google Scholar result, ResearchGate, IEEE, Springer, ACM…: journals publish the
    // PDF link and DOI in <meta name="citation_pdf_url"> for Google Scholar's indexer.
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content || null;
        const links = [...document.querySelectorAll("a[href]")].map((a) => a.href)
          .filter((h) => /\.pdf($|[?#])|\/pdf\/|download.*pdf|\/pdf$/i.test(h)).slice(0, 3);
        return { pdf: meta("citation_pdf_url"), doi: meta("citation_doi") || meta("dc.identifier"), title: meta("citation_title"), links };
      },
    }).then(([res]) => {
      const r = res?.result;
      const pdfUrl = r?.pdf || r?.links?.[0];
      if (pdfUrl) offerPdf(pdfUrl, r.doi, `এই পাতায় paper-এর PDF পাওয়া গেছে${r.title ? `: <b>${esc(r.title)}</b>` : ""}${r.doi ? `<br>DOI: ${esc(r.doi)}` : ""}`);
    }).catch(() => {}); // pages Chrome doesn't let extensions read
  }
  add(`<div class="box"><p><b>যেকোনো paper পড়তে:</b> arXiv, Google Scholar বা publisher-এর পাতায় paper খুলে আবার 🕷 চাপুন। অথবা computer-এ থাকা যেকোনো PDF আমাদের reader-এ খুলুন। (ResearchGate-এর মতো login লাগা সাইট থেকে আগে PDF download করে নিন।)</p><button id="open-viewer">📄 যেকোনো PDF খুলুন</button></div>`);
  $("#open-viewer").onclick = () => chrome.tabs.create({ url: viewer });
}
function alertBox(text) {
  $("#pdf").insertAdjacentHTML("afterbegin", `<div class="box warn"><p>${esc(text)}</p></div>`);
}

// ------------------------------------------------------------------ built-in AI setup
async function setupAI() {
  const box = $("#ai");
  const lmStatus = "LanguageModel" in self ? await LanguageModel.availability(LANG).catch(() => "unavailable") : "unavailable";
  const trStatus = "Translator" in self ? await Translator.availability({ sourceLanguage: "en", targetLanguage: "bn" }).catch(() => "unavailable") : "unavailable";

  if (lmStatus === "available" && trStatus !== "downloadable" && trStatus !== "downloading") return createAI(lmStatus, trStatus);
  if (lmStatus === "unavailable" && trStatus === "unavailable") {
    box.innerHTML = `<div class="box warn"><p><b>এই computer-এ Chrome-এর built-in AI চলে না।</b></p>
      <p>দরকার: Chrome 138+, desktop বা laptop, 16GB RAM বা 4GB+ graphics card, আর 22GB খালি জায়গা।</p>
      <p>Spider আর দাগ দেওয়া ঠিকই চলবে।</p></div>`;
    return;
  }
  // Needs a one-time download, which Chrome only starts after a click.
  box.innerHTML = `<div class="box"><p><b>AI চালু করুন</b>: একবার download হবে (কয়েক GB, কিছু মিনিট)। এরপর সব কিছু free আর internet ছাড়াই চলবে।</p>
    <button class="primary" id="ai-go">AI চালু করুন</button><div class="progress" hidden><i></i></div><p id="ai-msg"></p></div>`;
  $("#ai-go").onclick = () => createAI(lmStatus, trStatus);
}

async function createAI(lmStatus, trStatus) {
  const bar = $(".progress"), fill = $(".progress i"), msg = $("#ai-msg");
  if ($("#ai-go")) $("#ai-go").disabled = true;
  if (bar) bar.hidden = false;
  const monitor = (label) => (m) => m.addEventListener("downloadprogress", (e) => {
    if (fill) fill.style.width = Math.round(e.loaded * 100) + "%";
    if (msg) msg.textContent = `${label} download হচ্ছে… ${Math.round(e.loaded * 100)}%`;
  });
  try {
    // Start both downloads from this click (Chrome requires a click for downloads).
    const trP = trStatus !== "unavailable" ? Translator.create({ sourceLanguage: "en", targetLanguage: "bn", monitor: monitor("বাংলা অনুবাদক") }) : null;
    let opts = { ...LANG, initialPrompts: [{ role: "system", content: SYSTEM }], monitor: monitor("AI model") };
    const params = await LanguageModel.params?.().catch(() => null); // extensions may lower randomness
    if (params) opts = { ...opts, temperature: 0.2, topK: Math.min(3, params.maxTopK) };
    const lmP = lmStatus !== "unavailable" ? LanguageModel.create(opts) : null;
    [state.tr, state.lm] = await Promise.all([trP, lmP]);
    $("#ai").innerHTML = state.lm ? "" : `<div class="box warn"><p>এই computer-এ ব্যাখ্যাকারী AI চলে না, তাই শুধু বাংলা অনুবাদ দেখানো হবে।</p></div>`;
    pump();
  } catch (e) {
    if (msg) msg.textContent = "⚠ AI চালু করা গেল না: " + e.message;
    if ($("#ai-go")) $("#ai-go").disabled = false;
  }
}

// ------------------------------------------------------------------ explaining
function enqueue(job) {
  if (!job?.text?.trim() || job.isReferences) return;
  job.kind ||= job.isSelection ? "selection" : "section";
  job.level = state.level;
  job.id = [job.kind, job.section, job.level, job.kind === "selection" ? job.text.slice(0, 60) : ""].join("|");
  if (state.entries.some((e) => e.id === job.id) || state.queue.some((j) => j.id === job.id)) return;
  $("#now").textContent = "▸ " + (job.kind === "tldr" ? "TL;DR" : job.section);
  // Keep only what matters now: the TL;DR, a selection, and the newest section.
  state.queue = state.queue.filter((j) => j.kind !== "section" || job.kind !== "section");
  job.kind === "selection" ? state.queue.unshift(job) : state.queue.push(job);
  pump();
}

async function pump() {
  if (state.busy || !state.queue.length || (!state.lm && !state.tr)) return;
  state.busy = true;
  const job = state.queue.shift();
  try { await explain(job); } catch (e) { console.error(e); }
  state.busy = false;
  pump();
}

async function explain(job) {
  const entry = { id: job.id, kind: job.kind, section: job.section, title: job.paper.title, level: job.level, order: job.order ?? 999 };
  state.entries.push(entry);
  const card = makeCard(entry);
  const cacheKey = "c:" + job.paper.url + "|" + job.id;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];

  if (cached) Object.assign(entry, cached);
  else if (state.lm) {
    entry.ai = await askNano(job);
    entry.bn = state.tr ? await toBangla(entry.ai.explanation) : null;
    // Keep only terms that really occur in this section (code-checked), translate their meaning.
    const src = job.text.toLowerCase();
    entry.terms = [];
    for (const t of entry.ai.terms || []) {
      if (!t.term || !src.includes(t.term.toLowerCase().trim())) continue;
      entry.terms.push({ term: t.term.trim(), meaning: t.meaning, bn: await toBangla(t.meaning) });
    }
  } else {
    // No explaining model on this computer: translate the section itself (first part).
    entry.translationOnly = true;
    entry.bn = await toBangla(job.text.slice(0, 1200));
  }
  if (!cached) chrome.storage.local.set({ [cacheKey]: { ai: entry.ai, bn: entry.bn, terms: entry.terms, translationOnly: entry.translationOnly } }).catch(() => {});
  entry.checks = entry.ai && verify(entry.ai, job.text);
  renderCard(card, entry);
  for (const t of entry.terms || []) {
    const k = t.term.toLowerCase();
    if (!state.glossary.has(k)) state.glossary.set(k, { ...t, section: job.section });
  }
  renderGlossary();

  // Let the spider show where the answer comes from (not during full analysis: it would jump around).
  if (job.quiet) return;
  if (entry.checks?.evidenceOk) (await toTab({ type: "point", phrase: entry.ai.evidence })) || (entry.checks.keyOk && toTab({ type: "point", phrase: entry.ai.key }));
  else if (entry.checks?.keyOk) toTab({ type: "point", phrase: entry.ai.key });
}

async function askNano(job) {
  const what = job.kind === "selection" ? "this passage" : "this section";
  const prompt = `Paper: "${job.paper.title}"
Section: "${job.section}"
Reader: ${LEVELS[job.level]}.

TEXT:
"""
${job.text}
"""

Return JSON with:
- "explanation": explain ${what} to the reader in at most 90 words of plain English: what it says, why it matters, and the main result or number if there is one. Briefly define any technical term. Use ONLY facts from the TEXT; do not add facts or numbers.
- "evidence": ONE sentence copied word for word from the TEXT that best supports your explanation.
- "key": the most important short phrase or number from the TEXT, copied word for word (at most 6 words).
- "terms": up to 3 technical terms that appear in the TEXT and that this reader may not know. For each, "meaning": a correct, simple explanation (1-2 sentences) of what it means in this paper.`;
  const session = await state.lm.clone(); // fresh context per section, same settings
  try {
    const raw = await session.prompt(prompt, { responseConstraint: SCHEMA });
    return JSON.parse(raw);
  } finally {
    session.destroy();
  }
}

async function toBangla(text) {
  if (!state.tr || !text) return null;
  const p = protect(text);
  return restore(await state.tr.translate(p.text), p.terms);
}

// ------------------------------------------------------------------ rendering
function makeCard(entry) {
  const card = document.createElement("article");
  card.className = "card live";
  card.innerHTML = `<h4>${esc(entry.kind === "tldr" ? "TL;DR · পুরো paper এক নজরে" : entry.kind === "selection" ? "নির্বাচিত অংশ · " + entry.section : entry.section)}<span class="tag">${{ easy: "সহজ", mid: "মাঝারি", deep: "গভীর" }[entry.level]}</span></h4>
    <p class="bn thinking">ভাবছে…</p>`;
  $("#history").prepend(card);
  return card;
}

function renderCard(card, entry) {
  card.classList.remove("live");
  const bn = card.querySelector(".bn");
  bn.classList.remove("thinking");
  bn.textContent = entry.bn || entry.ai?.explanation || "";
  if (entry.translationOnly) bn.insertAdjacentHTML("beforebegin", `<p class="check warn">এটা AI ব্যাখ্যা না, মূল লেখার বাংলা অনুবাদ।</p>`);
  if (entry.ai) {
    card.insertAdjacentHTML("beforeend", `<details class="en" ${state.showEn ? "open" : ""}><summary>English</summary><p>${esc(entry.ai.explanation)}</p></details>`);
    const c = entry.checks;
    const checks = document.createElement("div");
    checks.className = "checks";
    checks.innerHTML =
      (c.evidenceOk
        ? `<div class="check ok">✅ প্রমাণ বাক্যটা paper-এ হুবহু আছে<q>${esc(entry.ai.evidence)}</q><button data-point="evidence">paper-এ দেখাও</button></div>`
        : `<div class="check warn">⚠️ AI-এর দেওয়া প্রমাণ বাক্য paper-এ হুবহু মেলেনি। এই ব্যাখ্যা সাবধানে পড়ুন।</div>`) +
      (c.numbers.length
        ? c.missingNumbers.length
          ? `<div class="check warn">⚠️ এই সংখ্যাগুলো এই অংশে পাওয়া যায়নি: <b>${esc(c.missingNumbers.join(", "))}</b>। মূল paper দেখে নিন।</div>`
          : `<div class="check ok">✅ ব্যাখ্যার সব সংখ্যা (${esc(c.numbers.join(", "))}) paper-এ আছে</div>`
        : "");
    checks.querySelector("[data-point]")?.addEventListener("click", () => toTab({ type: "point", phrase: entry.ai.evidence }));
    card.append(checks);
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ------------------------------------------------------------------ controls
function setLevel(level, rerun = true) {
  state.level = level;
  document.querySelectorAll("#levels [data-level]").forEach((b) => b.classList.toggle("on", b.dataset.level === level));
  chrome.storage.local.set({ level }).catch(() => {});
  if (rerun) refreshTab(); // explain where the reader is, at the new level
}
document.querySelectorAll("#levels [data-level]").forEach((b) => (b.onclick = () => setLevel(b.dataset.level)));
$("#lang").onclick = () => {
  state.showEn = !state.showEn;
  $("#lang").classList.toggle("on", state.showEn);
  document.querySelectorAll(".card .en").forEach((d) => (d.open = state.showEn));
};
$("#sel").onclick = async () => {
  const job = await toTab({ type: "selection" });
  if (!job) return alertBoxTop("আগে paper-এ কিছু লেখা mouse দিয়ে select করুন, তারপর এই বোতাম চাপুন।");
  enqueue(job);
};
$("#pause").onclick = async () => { const r = await toTab({ type: "cmd", cmd: "pause" }); if (r) $("#pause").textContent = r.paused ? "▶" : "⏸"; };
$("#clear").onclick = () => toTab({ type: "cmd", cmd: "clear" });
$("#drop").onclick = () => toTab({ type: "cmd", cmd: "drop" });
$("#intensity").onchange = (e) => toTab({ type: "cmd", cmd: "intensity", value: e.target.value });
// ------------------------------------------------------------------ full-paper analysis
$("#all").onclick = async () => {
  if (!state.lm && !state.tr) return alertBoxTop("আগে উপরের \"AI চালু করুন\" চাপুন।");
  const all = await toTab({ type: "all" });
  if (!all) return alertBoxTop("এই পাতায় কোনো paper পাওয়া যায়নি।");
  const sections = all.sections.filter((s) => s?.text?.trim() && !s.isReferences);
  state.paper = all.paper;
  $("#all").disabled = true;
  while (state.busy) await new Promise((r) => setTimeout(r, 300)); // let the current answer finish
  state.busy = true; // hold the normal queue while we go section by section
  const prog = $("#progress");
  prog.hidden = false;
  try {
    for (const [i, s] of sections.entries()) {
      prog.textContent = `📑 বিশ্লেষণ চলছে… ${i + 1}/${sections.length}: ${s.section}`;
      const kind = s.isAbstract ? "tldr" : "section";
      const id = [kind, s.section, state.level, ""].join("|");
      const old = state.entries.find((e) => e.id === id);
      if (old) { old.order = i; continue; }
      await explain({ ...s, kind, id, level: state.level, order: i, quiet: true }).catch(console.error);
    }
    prog.textContent = `✅ পুরো paper বিশ্লেষণ শেষ (${sections.length}টা অংশ)। "⤓ PDF report" চাপলে সব এক PDF-এ নামবে।`;
  } finally {
    state.busy = false;
    $("#all").disabled = false;
    pump();
  }
};

function renderGlossary() {
  if (!state.glossary.size) return;
  const items = [...state.glossary.values()].sort((a, b) => a.term.localeCompare(b.term));
  $("#glossary").innerHTML = `<div class="box"><p><b>📖 কঠিন শব্দের তালিকা (${items.length})</b></p>` +
    items.map((t) => `<p><b>${esc(t.term)}</b>: ${esc(t.bn || t.meaning)}</p>`).join("") + `</div>`;
}

// ------------------------------------------------------------------ PDF report (with DOI)
$("#export").onclick = async () => {
  const done = state.entries.filter((e) => e.ai || e.bn);
  if (!done.length) return alertBoxTop("আগে \"📑 পুরো paper বিশ্লেষণ\" চাপুন, তারপর PDF নামান।");
  // Ask for the one-time permission first, inside the click (Chrome requires it).
  const canPrint = await chrome.permissions.request({ permissions: ["debugger"] }).catch(() => false);
  const p = state.paper || { title: done[0].title };
  const report = {
    paper: p, level: state.level, date: new Date().toISOString().slice(0, 10),
    entries: done.sort((a, b) => (a.kind === "tldr" ? -1 : b.kind === "tldr" ? 1 : a.order - b.order))
      .map(({ kind, section, bn, ai, checks, translationOnly }) => ({ kind, section, bn, ai, checks, translationOnly })),
    glossary: [...state.glossary.values()].sort((a, b) => a.term.localeCompare(b.term)),
  };
  await chrome.storage.local.set({ report });
  // listen before opening, so a fast page can't signal before we're ready
  let readyTab = null, wake = null;
  const on = (msg, sender) => { if (msg.type === "report-ready") { readyTab = sender.tab?.id; wake?.(); } };
  chrome.runtime.onMessage.addListener(on);
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL("report.html"), active: !canPrint });
  if (!canPrint) return chrome.runtime.onMessage.removeListener(on); // report tab has its own "Save as PDF" button
  try {
    while (readyTab !== tab.id) await new Promise((r) => { wake = r; setTimeout(r, 500); });
    chrome.runtime.onMessage.removeListener(on);
    // Chrome's own PDF engine: Bangla text is shaped correctly and stays selectable.
    const target = { tabId: tab.id };
    await chrome.debugger.attach(target, "1.3");
    const { data } = await chrome.debugger.sendCommand(target, "Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
    await chrome.debugger.detach(target);
    chrome.tabs.remove(tab.id);
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    a.download = (p.title || "paper").replace(/[^\w\- ]+/g, "").trim().slice(0, 60).replace(/\s+/g, "-") + "-bangla-breakdown.pdf";
    a.click();
  } catch (e) {
    console.error(e);
    chrome.tabs.update(tab.id, { active: true }); // fall back: the report page's own print button
  }
};
function alertBoxTop(text) {
  const d = document.createElement("div");
  d.className = "box warn";
  d.innerHTML = `<p>${esc(text)}</p>`;
  $("#history").prepend(d);
  setTimeout(() => d.remove(), 6000);
}

// ------------------------------------------------------------------ boot
(async () => {
  const saved = await chrome.storage.local.get("level").catch(() => ({}));
  setLevel(saved.level || "easy", false);
  await setupAI();
  await refreshTab();
})();
