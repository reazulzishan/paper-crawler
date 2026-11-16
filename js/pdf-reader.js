// pdf-reader.js - turn ANY research-paper PDF into clean, structured HTML.
//
// PDFs don't store "paragraphs" or "sections", only positioned bits of text.
// We use Mozilla's pdf.js to read those bits, then rebuild the structure:
//   1. glue text bits into LINES (same height on the page)
//   2. find the body font size (the most common one)
//   3. bigger or numbered short lines ("3.2 Attention") become HEADINGS
//   4. other lines join into PARAGRAPHS (split on vertical gaps / sentence ends)
// The output uses the same class names as arXiv's HTML (LaTeXML), so the rest
// of Paper Crawler (sections, spider, markup) works on it unchanged.
// Equations and figures don't survive this; the original PDF stays one click away.

import * as pdfjs from "../vendor/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Read every page into lines: {page, x, y, xEnd, size, text}. */
async function readLines(pdf, onProgress) {
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    onProgress?.(p, pdf.numPages);
    const page = await pdf.getPage(p);
    const { items } = await page.getTextContent();
    let cur = null;
    for (const it of items) {
      if (!("str" in it)) continue;
      const [a, b, , , x, y] = it.transform;
      if (Math.abs(b) > 0.01 * Math.abs(a)) continue; // rotated text (e.g. the arXiv side stamp)
      const size = Math.round(Math.hypot(a, b) * 10) / 10 || it.height;
      const sameLine = cur && Math.abs(y - cur.y) < size * 0.55 && x > cur.x - size;
      if (!sameLine) {
        if (cur?.text.trim()) lines.push(cur);
        cur = { page: p, x, y, xEnd: x, size: 0, text: "" };
      }
      if (it.str) {
        const gap = x - cur.xEnd;
        if (cur.text && gap > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += " ";
        cur.text += it.str;
        cur.size = Math.max(cur.size, size);
        cur.xEnd = x + it.width;
      }
      if (it.hasEOL) { if (cur.text.trim()) lines.push(cur); cur = null; }
    }
    if (cur?.text.trim()) lines.push(cur);
    page.cleanup();
  }
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() }));
}

/** The most common font size, weighted by how much text uses it. */
function bodySize(lines) {
  const w = new Map();
  for (const l of lines) w.set(l.size, (w.get(l.size) || 0) + l.text.length);
  return [...w].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
}

const NAMED = /^(abstract|references|bibliography|acknowledge?ments?|appendix|conclusions?|introduction|related work|discussion|limitations)\b/i;
const NUMBERED = /^((?:\d{1,2}|[A-H])(?:\.\d{1,2}){0,3})\.?\s+([A-Z][^]{1,90})$/;

function headingOf(l, body, front) {
  const t = l.text;
  if (t.length > 90 || /[.,;:]$/.test(t) || l.size < body * 0.95) return null;
  const m = NUMBERED.exec(t);
  if (m && t.split(" ").length <= 12 && !/\d$/.test(t) && (l.size > body * 1.05 || /^[A-Z]/.test(m[2]))) {
    return { level: m[1].includes(".") ? 3 : 2, text: t };
  }
  if (NAMED.test(t) && t.length < 45) return { level: 2, text: t };
  // big unnumbered text counts only after the front matter (authors are big too)
  if (!front && l.size >= body * 1.18 && t.length < 80 && /[a-z]/i.test(t)) return { level: 2, text: t };
  return null;
}

export async function pdfToArticle(data, onProgress) {
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  let lines = await readLines(pdf, onProgress);
  if (!lines.length) throw new Error("This PDF has no text layer (it may be a scanned image).");

  // Drop page numbers and running headers/footers (same line on 3+ pages).
  const seen = new Map();
  for (const l of lines) seen.set(l.text, (seen.get(l.text) || 0) + 1);
  lines = lines.filter((l) => !/^\d{1,3}$/.test(l.text) && !(seen.get(l.text) >= 3 && l.text.length < 120));

  const body = bodySize(lines);

  // Title: the biggest text near the top of page 1.
  const first = lines.filter((l) => l.page === 1).slice(0, 25);
  const big = Math.max(...first.map((l) => l.size));
  let title = "";
  let i = 0;
  if (big > body * 1.25) {
    i = lines.findIndex((l) => l.page === 1 && l.size === big);
    while (i < lines.length && lines[i].page === 1 && lines[i].size === big) title += (title ? " " : "") + lines[i++].text;
  }

  // Walk the lines into blocks: headings and paragraphs.
  const out = [`<h1 class="ltx_title ltx_title_document">${esc(title || "Untitled PDF")}</h1>`];
  let para = "";
  let prev = null;
  let open = { sec: false, sub: false, abs: false };
  let front = true; // authors/affiliations before the first heading
  const flush = () => {
    if (para.trim()) out.push(`<p class="ltx_p">${esc(para.trim())}</p>`);
    para = "";
  };
  const close = (lvl) => {
    if (open.abs) { out.push("</div>"); open.abs = false; }
    if (open.sub) { out.push("</section>"); open.sub = false; }
    if (lvl === 2 && open.sec) { out.push("</section>"); open.sec = false; }
  };

  for (; i < lines.length; i++) {
    const l = lines[i];
    let h = headingOf(l, body, front);
    // "Abstract—We propose..." / "Abstract. We ..." on one line (IEEE / Springer style)
    const inlineAbs = /^abstract\s*[-—–.:]\s*(.+)/i.exec(l.text);
    if (inlineAbs) h = { level: 2, text: "Abstract" };
    if (h) {
      flush();
      if (front) { out.push("</div>"); front = false; }
      close(h.level);
      if (/^abstract/i.test(h.text)) {
        out.push(`<div class="ltx_abstract"><h6 class="ltx_title ltx_title_abstract">Abstract</h6>`);
        open.abs = true;
        if (inlineAbs) para = inlineAbs[1];
      } else if (/^(references|bibliography)/i.test(h.text)) {
        out.push(`<section class="ltx_bibliography"><h2 class="ltx_title ltx_title_bibliography">${esc(h.text)}</h2>`);
        open.sec = true;
      } else if (h.level === 2 || !open.sec) {
        out.push(`<section class="ltx_section"><h2 class="ltx_title ltx_title_section">${esc(h.text)}</h2>`);
        open.sec = true;
      } else {
        out.push(`<section class="ltx_subsection"><h3 class="ltx_title ltx_title_subsection">${esc(h.text)}</h3>`);
        open.sub = true;
      }
      prev = null;
      continue;
    }
    if (front && out.length === 1) out.push(`<div class="ltx_authors">`);
    // New paragraph on a big vertical gap, or after a short line that ends a sentence.
    if (prev && para) {
      const samePage = prev.page === l.page;
      const gap = samePage && l.y < prev.y ? prev.y - l.y : 0;
      const shortEnd = /[.:?!]$/.test(prev.text) && prev.xEnd - prev.x < (l.xEnd - l.x) * 0.75;
      if (gap > body * 1.9 || shortEnd || l.size < body * 0.85 !== prev.size < body * 0.85) flush();
    }
    // join lines, mending words hyphenated across a line break
    if (para && /[a-z]-$/.test(para) && /^[a-z]/.test(l.text)) para = para.slice(0, -1) + l.text;
    else para += (para ? " " : "") + l.text;
    prev = l;
  }
  flush();
  if (front && out.length > 1) out.push("</div>");
  close(2);

  return { title: title || "Untitled PDF", pages: pdf.numPages, html: `<article class="ltx_document">${out.join("\n")}</article>` };
}
