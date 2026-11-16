// ai.js - the best FREE AI each browser has, all running on the reader's device.
//
//   1. Chrome: Gemini Nano (built in) explains in English, Chrome's built-in
//      translator turns it into Bangla. Smallest download, fastest.
//   2. Any browser with WebGPU (Edge, Brave, Firefox, Safari 26, Chrome):
//      Qwen3.5 runs inside the page via WebLLM and writes Bangla directly.
//   3. Anything else (old computers, phones): hand the prompt to the reader's
//      own free Claude / ChatGPT account (see handoffUrl).
//
// Every engine returns the same shape, so the checks in checks.js work for all:
//   {explanation, bn, evidence, key, terms:[{term, meaning, bn}]}

import { protect, restore } from "./checks.js";

const WEBLLM = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm";
export const WEB_MODELS = {
  big: { id: "Qwen3.5-4B-q4f16_1-MLC", label: "Qwen3.5 4B", note: "ভালো মান · প্রায় 2.5 GB, 4 GB GPU memory" },
  small: { id: "Qwen3.5-2B-q4f16_1-MLC", label: "Qwen3.5 2B", note: "হালকা · প্রায় 1.3 GB, দুর্বল computer-এর জন্য" },
};

export const LEVELS = {
  easy: "a complete beginner (first-year university student). Use everyday words and one simple analogy",
  mid: "a computer-science student who knows basic machine learning",
  deep: "a machine-learning researcher. Be precise and technical",
};
const LANG = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };
const SYSTEM = "You are a careful teaching assistant who explains machine-learning research papers to students. " +
  "You never invent facts or numbers: everything you say must come from the text you are given.";
const termsSchema = (meaningKey) => ({
  type: "array", maxItems: 3,
  items: { type: "object", properties: { term: { type: "string" }, [meaningKey]: { type: "string" } }, required: ["term", meaningKey], additionalProperties: false },
});

function taskText(job, outLang) {
  const what = job.kind === "selection" ? "this passage" : "this section";
  const bn = outLang === "bn";
  return `Paper: "${job.paper.title}"
Section: "${job.section}"
Reader: ${LEVELS[job.level]}.

TEXT:
"""
${job.text}
"""

Return JSON with:
- "${bn ? "explanation_bn" : "explanation"}": explain ${what} to the reader in at most 90 words ${bn
    ? "of simple, natural Bangla (বাংলা). Keep technical terms, model names, dataset names and numbers in English exactly as written (for example attention, BLEU, Transformer)"
    : "of plain English"}: what it says, why it matters, and the main result or number if there is one. Briefly define any technical term. Use ONLY facts from the TEXT; do not add facts or numbers.
- "evidence": ONE sentence copied word for word, in English, from the TEXT that best supports your explanation.
- "key": the most important short phrase or number from the TEXT, copied word for word (at most 6 words).
- "terms": up to 3 technical terms that appear in the TEXT and that this reader may not know. For each, "${bn ? "meaning_bn" : "meaning"}": a correct, simple explanation (1-2 sentences${bn ? ", in Bangla" : ""}) of what it means in this paper.`;
}

/** Which engines can run here? (no downloads, no prompts) */
export async function detect() {
  // Some Chrome profiles never answer these checks; give each 3 s, then call it unavailable.
  const within = (p, fallback) => Promise.race([Promise.resolve(p).catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), 3000))]);
  const [nano, tr, gpu] = await Promise.all([
    "LanguageModel" in self ? within(LanguageModel.availability(LANG), "unavailable") : "unavailable",
    "Translator" in self ? within(Translator.availability({ sourceLanguage: "en", targetLanguage: "bn" }), "unavailable") : "unavailable",
    within(navigator.gpu?.requestAdapter().then((a) => !!a), false),
  ]);
  return { nano, tr, gpu };
}

// ------------------------------------------------------------------ 1. Chrome built-in
export class NanoEngine {
  name = "Chrome-এর built-in Gemini Nano + বাংলা অনুবাদক";
  /** Must be called from a click the first time (Chrome only downloads after a click). */
  async init(onProgress) {
    const monitor = (label) => (m) => m.addEventListener("downloadprogress", (e) => onProgress?.(label, e.loaded));
    const trP = "Translator" in self
      ? Translator.create({ sourceLanguage: "en", targetLanguage: "bn", monitor: monitor("বাংলা অনুবাদক") }).catch(() => null) : null;
    const lmP = LanguageModel.create({ ...LANG, initialPrompts: [{ role: "system", content: SYSTEM }], monitor: monitor("Gemini Nano") });
    [this.tr, this.lm] = await Promise.all([trP, lmP]);
  }
  async toBangla(text) {
    if (!this.tr || !text) return null;
    const p = protect(text);
    return restore(await this.tr.translate(p.text), p.terms);
  }
  async explain(job) {
    const schema = {
      type: "object",
      properties: { explanation: { type: "string" }, evidence: { type: "string" }, key: { type: "string" }, terms: termsSchema("meaning") },
      required: ["explanation", "evidence", "key", "terms"], additionalProperties: false,
    };
    const s = await this.lm.clone(); // fresh context per section
    let ai;
    try { ai = JSON.parse(await s.prompt(taskText(job, "en"), { responseConstraint: schema })); } finally { s.destroy(); }
    ai.bn = await this.toBangla(ai.explanation);
    for (const t of ai.terms || []) t.bn = await this.toBangla(t.meaning);
    return ai;
  }
}

// ------------------------------------------------------------------ 2. WebGPU in-page model
export class WebEngine {
  constructor(size = "big") { this.model = WEB_MODELS[size]; this.name = `${this.model.label} (আপনার browser-এ চলছে)`; }
  async init(onProgress) {
    const webllm = await import(WEBLLM);
    const load = (useIndexedDBCache) => webllm.CreateMLCEngine(this.model.id, {
      appConfig: { ...webllm.prebuiltAppConfig, useIndexedDBCache },
      initProgressCallback: (p) => onProgress?.(this.model.label, p.progress ?? 0, p.text),
    });
    try {
      this.engine = await load(false);
    } catch (e) {
      // Some browsers refuse multi-GB entries in the Cache API; IndexedDB usually takes them.
      if (!/cache/i.test(String(e))) throw e;
      this.engine = await load(true);
    }
  }
  async explain(job) {
    const schema = {
      type: "object",
      properties: { explanation_bn: { type: "string" }, evidence: { type: "string" }, key: { type: "string" }, terms: termsSchema("meaning_bn") },
      required: ["explanation_bn", "evidence", "key", "terms"], additionalProperties: false,
    };
    const res = await this.engine.chat.completions.create({
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: taskText(job, "bn") }],
      response_format: { type: "json_object", schema: JSON.stringify(schema) },
      temperature: 0.2,
      max_tokens: 1200,
      extra_body: { enable_thinking: false }, // answer directly: faster, and we only need the result
    });
    // Qwen may still write an (empty) <think>…</think> block first; keep only the JSON object.
    const raw = res.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, "");
    const out = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return {
      explanation: out.explanation_bn, bn: out.explanation_bn, evidence: out.evidence, key: out.key,
      terms: (out.terms || []).map((t) => ({ term: t.term, meaning: "", bn: t.meaning_bn })),
    };
  }
}

// ------------------------------------------------------------------ 0. Claude via Puter (instant, default)
// Puter's "user pays" model: the reader signs in once with a free Puter account
// and their own free allowance covers the calls. No key, no cost to the site owner.
const PUTER_SRC = "https://js.puter.com/v2/";
let puterLoading = null;
export function loadPuter() {
  if (window.puter) return Promise.resolve();
  return (puterLoading ||= new Promise((ok, fail) => {
    const s = document.createElement("script");
    Object.assign(s, { src: PUTER_SRC, onload: ok, onerror: () => fail(new Error("Puter লোড হয়নি। Internet connection দেখুন।")) });
    document.head.append(s);
  }));
}
export class PuterEngine {
  name = "Claude Haiku (Puter)";
  model = "claude-haiku-5-5";
  static signedIn() { return !!window.puter?.auth?.isSignedIn?.(); }
  /** Call from a click: Puter's sign-in opens a popup. */
  async init() {
    await loadPuter();
    if (!puter.auth.isSignedIn()) await puter.auth.signIn();
  }
  async explain(job) {
    const resp = await puter.ai.chat(taskText(job, "bn") + "\n\nReply with only the JSON object, no other text.", { model: this.model });
    const raw = typeof resp === "string" ? resp : resp?.message?.content?.[0]?.text ?? resp?.message?.content ?? String(resp);
    const out = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return {
      explanation: out.explanation_bn, bn: out.explanation_bn, evidence: out.evidence, key: out.key,
      terms: (out.terms || []).map((t) => ({ term: t.term, meaning: "", bn: t.meaning_bn })),
    };
  }
}

// ------------------------------------------------------------------ 3. hand off to Claude / ChatGPT
/** A ready-made prompt for the reader's own free Claude or ChatGPT account. */
export function handoffPrompt(job) {
  return `Explain this part of the research paper "${job.paper.title}"${job.paper.doi ? ` (DOI ${job.paper.doi})` : ""}, section "${job.section}", to ${LEVELS[job.level]}.
Answer in simple Bangla (বাংলা), keeping technical terms, names and numbers in English. In under 150 words: what it says, why it matters, the key result. Then list up to 5 hard terms with a short Bangla explanation each. Use only facts from the text below and quote the sentence your explanation is based on.

TEXT:
"""
${job.text.slice(0, 3500)}
"""`;
}
export const handoffUrl = {
  claude: (prompt) => "https://claude.ai/new?q=" + encodeURIComponent(prompt),
  chatgpt: (prompt) => "https://chatgpt.com/?q=" + encodeURIComponent(prompt),
};
