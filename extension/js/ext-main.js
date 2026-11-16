// ext-main.js - the in-page half of the extension.
//
// It puts the spider on the arXiv paper you're reading (same crawler as the
// web app, in "companion" mode: it follows YOUR scrolling). When the spider
// settles in a section, it sends that section's text to the side panel,
// where the free on-device AI explains it in Bangla + English.
// The panel sends back what to point at (the evidence sentence), and the
// spider runs there and highlights it so the reader can check it.

import { fromPage, findPhrase, sectionText } from "./loader.js";
import { Crawler } from "./crawler.js";

const MAX_TEXT = 4000; // Chrome's built-in model has a small context window

/** opts (PDF reader page only): {id, url, tabId} since that page's own URL isn't the paper's. */
export function start(opts = {}) {
  const article = document.querySelector("article.ltx_document");
  if (!article || window.__paperCrawler) return;

  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, {
    position: "fixed", inset: "0", width: "100vw", height: "100vh",
    pointerEvents: "none", zIndex: "2147483000",
  });
  document.body.append(canvas);

  const paper = fromPage(article);
  if (opts.id) paper.id = opts.id;
  const url = opts.url || location.href;
  const runtime = globalThis.chrome?.runtime;
  const send = (msg) => runtime?.id && runtime.sendMessage(msg).catch(() => {}); // panel may be closed

  // Title, authors, DOI for the report. arXiv papers all have a DataCite DOI.
  const info = {
    id: paper.id, title: paper.meta.title, url,
    authors: [...article.querySelectorAll(".ltx_personname")].map((e) => e.firstChild?.textContent.trim()).filter(Boolean).slice(0, 15).join(", ")
      || (article.querySelector(".ltx_authors")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
    doi: opts.doi
      || document.querySelector('meta[name="citation_doi"]')?.content
      || (/arxiv\.org$/.test(location.hostname) ? "10.48550/arXiv." + paper.id.replace(/v\d+$/, "") : null)
      || (/\b10\.\d{4,9}\/[^\s"<>]*[^\s"<>.,;)\]]/.exec(article.textContent.slice(0, 6000)) || [])[0]
      || null,
  };

  const payload = (s) => s && {
    type: "section",
    paper: info,
    section: s.title,
    isAbstract: s.isAbstract,
    isReferences: s.isReferences,
    text: sectionText(s, crawler.walked, MAX_TEXT),
  };

  const crawler = new Crawler({
    canvas, paperEl: article, companion: true,
    onSection: (s) => send(payload(s)),
  });
  crawler.setPaper(paper);
  window.__paperCrawler = crawler;

  // Point the spider at an exact phrase; true if found in the paper.
  const point = (phrase, cls = "m-key") => {
    const spans = phrase && findPhrase(phrase, article, crawler.currentSection()?.container);
    if (!spans) return false;
    crawler.pointAt(spans, () => spans.forEach((sp) => crawler.addClass(sp, cls)));
    return true;
  };

  runtime?.onMessage?.addListener((msg, _sender, reply) => {
    // The panel reaches the PDF reader page by broadcast, tagged with the tab id.
    if (msg.tabId !== undefined && msg.tabId !== opts.tabId) return;
    switch (msg.type) {
      case "current": // panel just opened: what is the reader looking at?
        reply({ abstract: payload(paper.sections.find((s) => s.isAbstract)), current: payload(crawler.currentSection()) });
        break;
      case "all": // full-paper analysis: every section, in order
        reply({ paper: info, sections: paper.sections.filter((s) => s.title !== "Title").map(payload) });
        break;
      case "point":
        reply(point(msg.phrase, msg.cls));
        break;
      case "selection": {
        const sel = getSelection();
        const text = String(sel).trim().slice(0, MAX_TEXT);
        if (text && sel.rangeCount) {
          const r = sel.getRangeAt(0).getBoundingClientRect();
          crawler.goTo(r.left + scrollX + Math.min(r.width / 2, 40), r.top + scrollY + r.height / 2);
        }
        reply(text ? { ...payload(crawler.currentSection()), text, isSelection: true } : null);
        break;
      }
      case "cmd":
        if (msg.cmd === "pause") crawler.paused = !crawler.paused;
        if (msg.cmd === "clear") crawler.clearMarkup();
        if (msg.cmd === "drop") crawler.drop();
        if (msg.cmd === "intensity") crawler.intensity = msg.value;
        if (msg.cmd === "hide") canvas.hidden = crawler.paused = !!msg.value;
        reply({ paused: crawler.paused, intensity: crawler.intensity });
        break;
    }
  });
}
