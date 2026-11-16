# Paper Crawler /[•]\

A spider that reads ML papers for you. It drops onto a real arXiv paper on a
silk thread, walks across it with its feet planted on actual words, and marks up
what it touches like a researcher with highlighters. As it crawls into each
section, Claude explains that section in plain English in the side panel.

It's a pun on "web crawler", but it really does read the paper.

Plain JavaScript, CSS and the Python standard library. No frameworks, no build
step, no npm.

## Website (for everyone, any browser): `site/`

`site/` is a static website, free to host on GitHub Pages. Readers open the link,
paste an arXiv link or drop any PDF, and get Bangla explanations. No install,
no account, no server.

It uses the best free AI each browser has, all running on the reader's device:

| Browser | AI | Download |
|---|---|---|
| Chrome | built-in Gemini Nano + built-in Bangla translator | once, by Chrome |
| Edge, Brave, Firefox, Safari 26 (WebGPU) | Qwen3.5 4B or 2B via [WebLLM](https://github.com/mlc-ai/web-llm), writes Bangla directly | about 2.5 GB / 1.3 GB, once |
| anything else, phones | "Claude-এ বুঝুন" / "ChatGPT-এ বুঝুন" buttons open the reader's own free account with the prompt and section text filled in | none |

Same checks as the extension (evidence sentence and numbers matched against the
paper by code), full-paper analysis with a glossary, and a PDF report with the
DOI (made in the browser with html2pdf.js, so Bangla is shaped correctly).

**Live:** <https://reazulzishan.github.io/paper-crawler/>

Run locally: `python3 serve.py`, then open <http://localhost:5173/site/>.
Rebuild after editing shared code: `python3 build_extension.py` (it also refreshes `site/`).

Publish an update (GitHub Pages serves the `gh-pages` branch, which is just the `site/` folder):

```bash
python3 build_extension.py && git add -A && git commit -m "Update" && git push && git subtree push --prefix site origin gh-pages
```

## Chrome extension: Bangla explanations on any paper

The `extension/` folder is a Chrome extension. The reader installs it once.
After that the spider appears on any arXiv paper, and Google Scholar,
publisher pages or any PDF open in the extension's own reader. A side panel
explains each section in simple **Bangla + English**.

- **Free, no account, no key, works offline.** The AI is Gemini Nano, which is
  built into Chrome. Bangla comes from Chrome's built-in translator. Both run
  on the reader's computer.
- **Checks you can trust.** Each explanation comes with one sentence copied
  from the paper. Code (not AI) checks that the sentence really is in the paper
  (✅/⚠️), and checks that every number in the explanation appears in the
  section. The spider then highlights that sentence on the page.
- **Full-paper analysis** (📑): every section explained, plus a list of
  technical terms with explanations. Terms are kept only if they really occur
  in the paper.
- **PDF report** (⤓): title, authors, DOI, every section in Bangla + English,
  the checks, and the glossary, saved as one PDF.

Needs Chrome 138+ on a desktop or laptop with 16 GB RAM (or a GPU with more
than 4 GB) and 22 GB free disk for Gemini Nano. On weaker computers the spider
still works and the panel shows a Bangla translation of each section instead.

### ইনস্টল করার নিয়ম

1. Chrome-এ `chrome://extensions` খুলুন।
2. উপরে ডানদিকে **Developer mode** চালু করুন।
3. **Load unpacked** চাপুন, তারপর `paper-crawler/extension` folder বেছে নিন।
   (অন্যকে দিতে চাইলে `dist/paper-crawler-extension.zip` পাঠান; সে unzip করে একই কাজ করবে।)
4. Puzzle icon 🧩 থেকে Paper Crawler-কে pin করুন।
5. যেকোনো arXiv paper খুলুন, যেমন <https://arxiv.org/html/1706.03762>। Spider নেমে আসবে।
6. 🕷 icon চাপুন। পাশে panel খুলবে। প্রথমবার **AI চালু করুন** চাপুন (একবার download হবে)।
7. Google Scholar, IEEE বা Springer-এর পাতায় 🕷 চাপলে paper-এর PDF খুঁজে খুলে দেবে।
   PDF থাকলে **📄 যেকোনো PDF খুলুন** দিয়ে টেনে আনুন।

After editing anything in `js/` or `css/style.css`, run `python3 build_extension.py`
to copy the shared spider code into the extension and rebuild the zip.

## Run it (local web app)

```bash
python3 serve.py                      # http://localhost:5173
```

To read any paper, paste its arXiv link into the box at the top and press
**Open**. The paper and its figures are saved in `papers/`, so after the first
time it opens without internet.

### Which AI explains the paper

Set it in `.env`:

| `.env` | AI | Cost | Internet |
|---|---|---|---|
| `AI_BACKEND=ollama` | local model on your Mac via [Ollama](https://ollama.com) (`qwen3:8b` by default) | free | not needed |
| `ANTHROPIC_API_KEY=sk-ant-...` + `AI_BACKEND=auto` | Claude (`claude-sonnet-5-5`) | API credits | needed |

One-time setup for the free local AI (about 5 GB):

```bash
brew install ollama
ollama pull qwen3:8b
```

`serve.py` starts Ollama by itself if it isn't running. Change the model with
`OLLAMA_MODEL=...` in `.env`; a smaller one such as `gemma3:4b` is faster on
8 GB Macs. The local model is weaker than Claude: its explanations are simpler
and its KEY phrase doesn't always match the paper word for word.

With no AI at all, the spider still crawls and marks up the paper.

Papers can also be downloaded from the terminal:

```bash
python fetch_paper.py 1810.04805
python fetch_paper.py https://arxiv.org/abs/2005.14165
python fetch_paper.py --batch "1706.03762 2005.14165 1810.04805"
```

They show up in the dropdown on the next page load.

## Controls

| Input | What it does |
|---|---|
| Mouse move | spider chases the cursor (goes back to reading 1.4s after you stop) |
| Click | send it to that spot |
| `Space` | pause |
| `F` | camera follow on/off |
| `T` | title overlay ("I built a spider that reads ML papers for me") |
| `1` `2` `3` | markup intensity: calm / normal / wild |
| `B` `S` `R` | explanation level: beginner / student / researcher (re-explains the current section) |
| select text, then `E` | spider runs to it and Claude explains just that passage |
| `C` | clear all markup |
| `D` | re-drop the spider from the top |
| `?debug` in the URL | IK reach circles, step thresholds, foot targets, FPS; `window.__crawler` |

Change the overlay text in `TITLE_TEXT` at the top of `js/loader.js`.
Change the model in `MODEL` and the prompt in `PROMPT` at the top of `serve.py`.

## How it works, in plain English

```
fetch_paper.py ──► papers/{id}.html + .json
                        │
index.html ── loader.js (clean, sections, word spans)
                ├── crawler.js (brain, IK, gait, feet, markup, camera) ─► spider-draw.js (canvas)
                └── analyst.js (AI panel) ──POST /api/explain──► serve.py ──► Claude API
                                          ◄──── SSE text stream ───┘
```

### 1. Getting the paper (`fetch_paper.py`)

The browser can't download from arxiv.org directly because of CORS, so a Python
script does it once and saves the result locally.

1. It asks the **arXiv API** (`export.arxiv.org/api/query?id_list=…`) for title,
   authors, date and abstract. The answer is Atom XML, read with `xml.etree`.
2. It downloads the paper as HTML from **arxiv.org/html/{id}** (native HTML,
   most papers from late 2023 on). If that fails it tries
   **ar5iv.labs.arxiv.org/html/{id}**, which converted older LaTeX papers to
   HTML. Both use a converter called LaTeXML, so the page always has the same
   class names (`ltx_section`, `ltx_title`, …) and the loader can rely on them.
3. It rewrites relative `src`/`href` URLs to absolute ones so figures still load.
4. It waits 3 seconds between requests and sends a descriptive User-Agent, which
   is what arXiv asks of scripts.

### 2. Loading and cleaning (`loader.js`)

- Keeps only the `<article>` from the downloaded HTML and drops scripts and
  arXiv's page chrome. MathML equations stay as they are; browsers render them
  natively.
- **Sections:** every Abstract, `h2` section and `h3` subsection heading starts
  one. A section's own text is the paragraphs directly inside it, so
  "3 Model Architecture" doesn't swallow "3.2 Attention".
- **Footholds:** each word becomes `<span class="w">word</span>`, so the spider
  has something real to stand on. A paper has tens of thousands of words, so
  this runs lazily: an `IntersectionObserver` wraps a paragraph only when it
  comes within about one screen of view. Math, code and images are never split.

### 3. The spider (`crawler.js` + `spider-draw.js`)

Every frame runs three steps:

1. `update()` decides everything and only **reads** the page (word positions,
   scroll).
2. `draw()` paints the spider on a full-screen `<canvas>` that has
   `pointer-events: none`, so the paper underneath stays clickable.
3. `commit()` applies every queued page **write** (adding highlight classes,
   scrolling) in one batch.

Mixing reads and writes forces the browser to recompute layout several times per
frame. Batching keeps it to one layout per frame, which is how it holds 60fps on
a long paper (about 0.5 ms of script per frame).

The spider's position is stored in page coordinates, not screen coordinates.
When the paper scrolls, the spider moves with it, as if it were standing on the
paper.

**Inverse kinematics (two-bone IK).** Each leg is two bones: thigh (34px) and
shin (40px). We know where the hip is (on the body) and where the foot should be
(on a word). The job is to find the knee. Hip, knee and foot form a triangle with
known side lengths: thigh, shin, and the hip-to-foot distance `d`. The **law of
cosines** gives the angle at the hip:

```
cos(α) = (thigh² + d² − shin²) / (2 · thigh · d)
knee   = hip + thigh · (cos(base ± α), sin(base ± α))
```

`base` is the direction from hip to foot. The `±` picks one of the two possible
knees. Each leg's sign is fixed once at startup, choosing the knee that sits
farther from the body, mirrored left/right, so knees never flip mid-walk. See
`solveIK()` in `crawler.js`.

**Gait (alternating tetrapod).** Real spiders move four legs at a time. The legs
are split into two groups: L1, R2, L3, R4 and R1, L2, R3, L4. Each leg has a
"rest spot" relative to the body. When the body moves and a foot falls more than
about 22px behind its rest spot, that leg wants to step, but only while the other
group is planted. A leg stretched past its reach steps immediately whatever the
rule says. A step is an eased 120 to 180 ms swing that aims a little ahead of
where the body is going.

**Wandering.** Smooth "value noise" moves the target from side to side across
the column, while a reading line moves slowly down the page. Random short pauses
make it look like it stops to read. It stops at References.

**Entrance.** The spider starts above the screen and comes down on a silk thread
with its legs tucked in. When it lands, all eight legs step out at once. The
thread stays attached to the top of the screen and sways until the spider has
walked about 220px away, then it snaps and pulls back up.

### 4. Feet on real words

When a foot lands, `document.elementFromPoint()` asks the browser which element
is under that spot. If it's a word span, link or table cell, the foot sticks to
it at that relative spot inside the word. If not, it probes a small ring around
the point. While planted, the foot re-reads its word's position every frame, so
it moves with scrolling and reflow. If the word jumps more than 30px (say a
neighbor got blown up to 2.4x size), the foot lets go and steps again. Faint
silk lines run from the abdomen to the last few words it touched.

### 5. Markup effects

Every foot plant can add a CSS class to the word it touched (`css/style.css`,
classes `.m-*`): colored boxes, orange/magenta/cyan/green highlighter bars,
numbers blown up 2 to 3x, phrases rotated -70° in green, recolored text. Section
headings turn into purple monospace bars as the spider enters them. Marks stay,
so the spider leaves an annotation trail.

**Smart targeting:** `classify()` checks whether the word looks like a metric
(`28.4`, `92.1%`, `BLEU`), a model name (CamelCase, ALL-CAPS, Transformer,
LoRA…), a dataset (ImageNet, WMT, GLUE…), a citation, an equation number, or a
claim word ("propose", "outperforms", "novel"). Those words are 3x more likely to
get marked, and they get the dramatic styles. Metrics, models and datasets are
also logged to **Crawler Notes** with their section and sentence.

### 6. The AI explainer (`serve.py` + `analyst.js`)

1. The spider's body stays in a new section for 1.2s, so quick fly-overs don't
   cost anything.
2. `analyst.js` collects the section's text (paragraphs the spider walked over
   first, about 12k characters max) and POSTs `{title, section, text, level}` to
   `/api/explain`. Requests go one at a time; the rest wait in a queue. The
   abstract is explained right at load as the **TL;DR**.
3. `serve.py` holds the API key; the browser never sees it. It fills in the
   prompt and calls the Anthropic Messages API with `stream: true`.
4. Claude's answer streams back word by word. `serve.py` passes each piece to
   the browser as **Server-Sent Events**, so the explanation types out live.
5. The last line of the answer is `KEY: <exact phrase>`. The panel finds that
   phrase in the paper, the spider runs to it and hits it with the biggest
   markup: a 2.2x orange word in a red box. The spider points at what the AI
   found. Click the KEY chip to send it there again.
6. Each answer is saved to `cache/{paper}_{section}_{level}.json`, so re-runs
   cost nothing.

**Export:** `⤓ breakdown.md` gives you a Markdown file with the TL;DR, each
section explained, key results, and the models and datasets mentioned. It works
as Obsidian notes or a carousel script. `⤓ notes.json` exports Crawler Notes.

## Files

```
fetch_paper.py      downloads an arXiv paper as HTML into papers/
papers/             saved papers + index.json (the dropdown list)
serve.py            static server + /api/explain proxy to Claude
cache/              cached AI explanations (gitignored)
index.html          entry point + keyboard wiring
css/style.css       paper theme, AI panel, all .m-* markup classes
js/loader.js        load, clean, sections, word spans, phrase search
js/crawler.js       spider brain: IK, gait, thread drop, feet, effects, camera, loop
js/spider-draw.js   canvas rendering of spider + silk
js/analyst.js       AI explainer panel, Crawler Notes, export
```

## Five famous ML papers to try

| arXiv ID | Paper |
|---|---|
| `1706.03762` | Attention Is All You Need (Transformer, 2017) |
| `1810.04805` | BERT (2018) |
| `1512.03385` | Deep Residual Learning, ResNet (2015) |
| `2005.14165` | Language Models are Few-Shot Learners, GPT-3 (2020) |
| `2106.09685` | LoRA: Low-Rank Adaptation of LLMs (2021) |

```bash
python fetch_paper.py --batch "1512.03385 2005.14165 2106.09685"
```

Very long papers like GPT-3 (75 pages) still run smoothly because words are
wrapped lazily, but the first section explanations take a moment to queue up.
