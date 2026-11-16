// report-html.js - the full-paper breakdown as one A4-ready HTML block.
// Shared by the extension (printed with Chrome's PDF engine) and the website
// (turned into a PDF in the browser). Style: css/report.css.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LEVEL = { easy: "সহজ (beginner)", mid: "মাঝারি (student)", deep: "গভীর (researcher)" };

/** r = {paper:{title, authors, doi, url}, level, date, ai, entries:[...], glossary:[...]} */
export function reportHtml(r) {
  const p = r.paper;
  const doi = p.doi ? `<a href="https://doi.org/${esc(p.doi)}">https://doi.org/${esc(p.doi)}</a>` : "পাওয়া যায়নি";
  const section = (e) => {
    const c = e.checks;
    const checks = !e.ai ? "" : (c?.evidenceOk
      ? `<div class="ok">✅ প্রমাণ (paper-এ হুবহু আছে): <q>${esc(e.ai.evidence)}</q></div>`
      : `<div class="warn">⚠️ AI-এর প্রমাণ বাক্য paper-এ হুবহু মেলেনি। মূল paper দেখে নিন।</div>`) +
      (c?.missingNumbers?.length ? `<div class="warn">⚠️ এই সংখ্যাগুলো এই অংশে পাওয়া যায়নি: ${esc(c.missingNumbers.join(", "))}</div>` : "");
    return `<section>
      <h2>${e.kind === "tldr" ? "TL;DR: পুরো paper এক নজরে" : esc(e.section)}</h2>
      ${e.translationOnly ? `<p class="note">মূল লেখার বাংলা অনুবাদ (AI ব্যাখ্যা নয়)</p>` : ""}
      <p class="bn">${esc(e.bn || e.ai?.explanation)}</p>
      ${e.ai?.explanation && e.bn && e.ai.explanation !== e.bn ? `<p class="en">${esc(e.ai.explanation)}</p>` : ""}
      ${checks}
    </section>`;
  };
  return `
  <header>
    <div class="brand">/[•]\\ Paper Crawler · বাংলায় paper বিশ্লেষণ</div>
    <h1>${esc(p.title)}</h1>
    ${p.authors ? `<p class="authors">${esc(p.authors)}</p>` : ""}
    <table class="meta">
      <tr><th>DOI</th><td>${doi}</td></tr>
      ${p.url && /^https?:/.test(p.url) ? `<tr><th>Link</th><td>${esc(p.url)}</td></tr>` : ""}
      <tr><th>ব্যাখ্যার স্তর</th><td>${LEVEL[r.level] || esc(r.level)}</td></tr>
      <tr><th>তারিখ</th><td>${esc(r.date)}</td></tr>
    </table>
    <p class="disclaimer">এই ব্যাখ্যা AI দিয়ে তৈরি (${esc(r.ai || "on-device AI")})। AI ভুল করতে পারে।
    ✅ চিহ্ন মানে code দিয়ে মিলিয়ে দেখা হয়েছে যে প্রমাণ বাক্যটা paper-এ হুবহু আছে। গবেষণার কাজে সবসময় মূল paper থেকে মিলিয়ে নিন।</p>
  </header>
  ${r.entries.map(section).join("")}
  ${r.glossary.length ? `<section class="glossary"><h2>📖 কঠিন শব্দের তালিকা</h2>
    <table><tr><th>শব্দ</th><th>বাংলায় মানে</th><th>English</th></tr>
    ${r.glossary.map((t) => `<tr><td><b>${esc(t.term)}</b><br><small>${esc(t.section)}</small></td><td>${esc(t.bn || "")}</td><td>${esc(t.meaning || "")}</td></tr>`).join("")}
    </table></section>` : ""}
  <footer>Paper Crawler দিয়ে তৈরি${p.doi ? ` · মূল paper: doi.org/${esc(p.doi)}` : ""}</footer>`;
}
