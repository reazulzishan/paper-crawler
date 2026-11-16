// viewer.js - the extension's own PDF reader, so the spider works on ANY paper.
// Opens a PDF from ?file=<url> or from a file you pick / drop, turns it into
// readable text (pdf-reader.js), then starts the spider on it.

import { pdfToArticle } from "./pdf-reader.js";
import { start } from "./ext-main.js";

const $ = (id) => document.getElementById(id);
const status = (t) => ($("status").textContent = t);
let loaded = false;

async function open(buf, name, url) {
  if (loaded) return location.reload(); // one paper per page keeps things simple
  const id = "pdf:" + name + ":" + buf.byteLength;
  try {
    status("PDF পড়া হচ্ছে…");
    const r = await pdfToArticle(buf, (p, n) => status(`PDF পড়া হচ্ছে… পৃষ্ঠা ${p}/${n}`));
    $("paper").innerHTML = r.html;
    document.title = r.title + " · Paper Crawler";
    status(`${r.pages} পৃষ্ঠা · লেখা আলাদা করে দেখানো হচ্ছে (equation ও ছবি মূল PDF-এ দেখুন)`);
    if (url) Object.assign($("orig"), { href: url, hidden: false });
    loaded = true;
    const tab = await globalThis.chrome?.tabs?.getCurrent?.();
    start({ id, url: url || "file:" + name, tabId: tab?.id, doi: params.get("doi") });
  } catch (e) {
    status("⚠ এই PDF পড়া গেল না: " + e.message);
  }
}

$("pick").onchange = async (e) => {
  const f = e.target.files[0];
  if (f) open(await f.arrayBuffer(), f.name);
};
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (f) open(await f.arrayBuffer(), f.name);
});

const params = new URLSearchParams(location.search);
const file = params.get("file");
if (file) {
  status("PDF download হচ্ছে…");
  fetch(file)
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
    .then((buf) => open(buf, file.split("/").pop() || "paper.pdf", file))
    .catch((e) => status(`⚠ PDF আনা গেল না (${e.message})। PDF-টা download করে এখানে টেনে আনুন।`));
}
