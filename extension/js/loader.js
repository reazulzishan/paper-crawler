// loader.js - load a saved arXiv paper, clean it, detect sections, and turn
// words into <span class="w"> "footholds" for the spider.
//
// The papers were downloaded by fetch_paper.py as LaTeXML HTML (that is what
// arxiv.org/html and ar5iv both produce), so we can rely on its class names:
//   article.ltx_document   the paper body
//   .ltx_abstract          the abstract
//   h2/h3.ltx_title        section / subsection headings
//   math                   MathML (renders natively - never touch its insides)

export const TITLE_TEXT = "I built a spider that reads ML papers for me";

// Text inside these is never split into words.
const SKIP = "math, code, pre, svg, script, style, .w, img, .ltx_note_outer";
// Blocks that hold readable text; each is wrapped lazily when it nears the viewport.
const BLOCKS = "p, h1, h2, h3, h4, h5, h6, figcaption, td, th, li, .ltx_bibitem, .ltx_authors, .ltx_caption";

export async function listPapers() {
  const r = await fetch("papers/index.json");
  return r.ok ? r.json() : [];
}

export async function loadPaper(id, container) {
  const [html, meta] = await Promise.all([
    fetch(`papers/${id}.html`).then((r) => { if (!r.ok) throw new Error(`papers/${id}.html not found`); return r.text(); }),
    fetch(`papers/${id}.json`).then((r) => r.json()),
  ]);

  // Parse off-DOM, then keep only the <article>. Scripts never run from DOMParser.
  const doc = new DOMParser().parseFromString(html, "text/html");
  const article = doc.querySelector("article.ltx_document") || doc.body;
  article.querySelectorAll("script, style, link, .ltx_page_footer, .package-alerts, .ltx_ERROR, button, nav")
    .forEach((n) => n.remove());
  // Links inside the paper should not navigate away from the app.
  article.querySelectorAll("a[href]").forEach((a) => {
    if (!a.getAttribute("href").startsWith("#")) a.target = "_blank";
  });

  container.replaceChildren(document.adoptNode(article));
  container.scrollTop = 0;
  const sections = detectSections(article, meta);
  lazyWrap(article);
  return { id, meta, article, sections };
}

/**
 * Use the paper that is already on screen (the Chrome extension runs on
 * arxiv.org/html pages, which are the same LaTeXML HTML we download).
 */
export function fromPage(article) {
  const title = (article.querySelector("h1.ltx_title_document")?.textContent || document.title).replace(/\s+/g, " ").trim();
  const id = (location.pathname.match(/\/html\/([^/]+)/) || [])[1] || location.pathname;
  const meta = { id, title, authors: [], abstract: null };
  const sections = detectSections(article, meta);
  lazyWrap(article);
  return { id, meta, article, sections };
}

// ---------------------------------------------------------------------------
// Sections: every Abstract / h2 section / h3 subsection heading starts one.
// A section's "own" paragraphs are those whose nearest section container is
// its container, so "3 Model Architecture" doesn't swallow "3.2 Attention".
// ---------------------------------------------------------------------------
function detectSections(article, meta) {
  const sections = [];
  const heads = article.querySelectorAll(
    ".ltx_abstract > .ltx_title, h2.ltx_title, h3.ltx_title, h1.ltx_title_document");
  for (const h of heads) {
    const container = h.closest("section, .ltx_abstract, .ltx_bibliography") || h.parentElement;
    const isTitle = h.matches("h1");
    const title = isTitle ? "Title" : h.textContent.replace(/\s+/g, " ").trim();
    sections.push({
      title,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      heading: h,
      container,
      isAbstract: !!h.closest(".ltx_abstract"),
      isReferences: !!h.closest(".ltx_bibliography") || /^\s*references\s*$/i.test(title),
      top: 0, // page Y, filled by measureSections()
    });
  }
  // Papers with no abstract block: fake one from the API metadata.
  if (!sections.some((s) => s.isAbstract) && meta.abstract) {
    const t = sections.find((s) => s.title === "Title");
    if (t) { t.isAbstract = true; t.fallbackText = meta.abstract; t.title = "Abstract"; }
  }
  measureSections(sections);
  return sections;
}

/** Cache each heading's page-Y. Call again after resize/images load (layout read). */
export function measureSections(sections) {
  for (const s of sections) s.top = s.heading.getBoundingClientRect().top + scrollY;
}

/** Index of the section containing page-Y `y` (last heading above it). */
export function sectionAt(sections, y) {
  let idx = 0;
  for (let i = 0; i < sections.length; i++) if (sections[i].top <= y + 10) idx = i;
  return idx;
}

/**
 * Plain text of a section, trimmed to `max` chars. Paragraphs the spider
 * walked over (the `walked` Set of elements) go first.
 */
export function sectionText(section, walked = new Set(), max = 12000) {
  if (section.fallbackText) return section.fallbackText;
  let paras = [...section.container.querySelectorAll(".ltx_p, p, figcaption, .ltx_bibitem")]
    .filter((p) => !p.parentElement.closest(".ltx_p, p") &&
      p.closest("section, .ltx_abstract, .ltx_bibliography") === section.container);
  if (!paras.length) paras = [section.container];
  paras.sort((a, b) => walked.has(b) - walked.has(a));
  let out = "";
  for (const p of paras) {
    const t = p.innerText.replace(/\s+/g, " ").trim();
    if (out.length + t.length > max) { out += t.slice(0, max - out.length); break; }
    out += t + "\n\n";
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// Word wrapping. Papers are long (thousands of words), so we only wrap blocks
// within ~1 screen of the viewport, using an IntersectionObserver.
// ---------------------------------------------------------------------------
let observer;
function lazyWrap(article) {
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { wrapWords(e.target); observer.unobserve(e.target); }
  }, { rootMargin: "800px 0px" });
  article.querySelectorAll(BLOCKS).forEach((b) => observer.observe(b));
}

/** Split every text node under `root` into <span class="w">word</span> + plain spaces. */
export function wrapWords(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => !n.nodeValue.trim() || n.parentElement.closest(SKIP)
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    for (const part of n.nodeValue.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { frag.append(part); continue; }
      const s = document.createElement("span");
      s.className = "w";
      s.textContent = part;
      frag.append(s);
    }
    n.replaceWith(frag);
  }
}

/**
 * Find an exact phrase (e.g. the AI's KEY: line) in the paper. Searches
 * `preferRoot` first. Returns the array of .w spans covering it, or null.
 */
export function findPhrase(phrase, article, preferRoot) {
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const want = norm(phrase).replace(/^["'“]|["'”.]$/g, "");
  if (want.length < 2) return null;
  const words = want.split(" ");
  for (const root of [preferRoot, article].filter(Boolean)) {
    for (const block of root.querySelectorAll(".ltx_p, p, td, figcaption, li, h2, h3")) {
      if (!norm(block.textContent).includes(words[0])) continue;
      if (!norm(block.textContent).includes(want)) continue;
      wrapWords(block);
      const spans = [...block.querySelectorAll(".w")];
      // Slide over the spans comparing word by word (punctuation-insensitive).
      const clean = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}.%+\-]/gu, "").replace(/\.$/, "");
      const target = words.map(clean);
      for (let i = 0; i < spans.length; i++) {
        let ok = true;
        for (let j = 0; j < target.length && ok; j++) {
          const w = spans[i + j] && clean(spans[i + j].textContent);
          ok = w !== undefined && (w === target[j] || (j === target.length - 1 && w.startsWith(target[j])));
        }
        if (ok) return spans.slice(i, i + target.length);
      }
    }
  }
  return null;
}
