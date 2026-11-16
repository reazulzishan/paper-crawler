// checks.js - the parts of accuracy that CODE guarantees, not the AI.
//
// verify():  is the AI's evidence sentence really in the paper, word for word?
//            does every number in its explanation appear in the section text?
// protect()/restore(): keep technical terms in English through translation,
//            so "attention" doesn't become "মনোযোগ প্রক্রিয়া".

const norm = (s) => s.toLowerCase()
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim()
  .replace(/[.\s]+$/, "");

export function verify(ai, sourceText) {
  const src = norm(sourceText);
  const evidence = (ai.evidence || "").trim();
  const key = (ai.key || "").trim();
  // Bangla explanations may write numbers in Bangla digits (২৮.৪ = 28.4).
  const expl = (ai.explanation || "").replace(/[০-৯]/g, (d) => "০১২৩৪৫৬৭৮৯".indexOf(d));
  const numbers = [...new Set(expl.match(/\d+(?:[.,]\d+)?/g) || [])];
  return {
    evidenceOk: evidence.length >= 12 && src.includes(norm(evidence)),
    keyOk: key.length >= 2 && src.includes(norm(key)),
    numbers,
    missingNumbers: numbers.filter((n) => !src.includes(n)),
  };
}

// ML words readers in Bangladesh already say in English.
const TERMS = [
  "multi-head attention", "self-attention", "attention mechanisms?", "attention", "transformers?",
  "encoders?", "decoders?", "embeddings?", "tokens?", "layers?", "neural networks?", "recurrent", "recurrence",
  "convolutional", "convolutions?", "datasets?", "benchmarks?", "fine-tuning", "fine-tuned?", "pre-training",
  "pretraining", "pre-trained", "hyperparameters?", "parameters?", "gradients?", "loss", "softmax", "accuracy",
  "baselines?", "models?", "training", "inference", "vectors?", "matrix", "matrices", "architectures?",
  "state-of-the-art", "sequences?", "feed-forward", "dropout", "batch(?:es)?", "epochs?", "overfitting",
  "regularization", "classifiers?", "labels?", "prompts?", "language models?", "algorithms?", "optimizer",
  "residual", "latent", "diffusion", "reinforcement learning", "supervised", "unsupervised", "fine-tune",
];
// Case-sensitive on purpose (the caps rule needs it); glossary words also match capitalized.
const PROTECT_RE = new RegExp(
  "\\b(?:" + TERMS.map((t) => `[${t[0].toUpperCase()}${t[0]}]${t.slice(1)}`).join("|") + ")\\b" + // glossary
  "|\\b[A-Za-z]*[A-Z][a-z]*[A-Z][\\w-]*" +          // CamelCase / ALL-CAPS: BERT, ResNet, GPT-3
  "|\\b\\w*\\d[\\w.%-]*",                           // anything with a digit: 28.4, WMT2014, 3x
  "g",
);

/** Swap protected terms for ⟦n⟧ placeholders (tested: Chrome's translator keeps these). */
export function protect(text) {
  const terms = [];
  const out = text.replace(PROTECT_RE, (m) => `⟦${terms.push(m) - 1}⟧`);
  return { text: out, terms };
}
export function restore(text, terms) {
  return text.replace(/⟦\s*(\d+)\s*⟧/g, (m, i) => terms[+i] ?? m);
}

// Self-check (runs once when the panel loads; cheap).
{
  const src = "Our model achieves 28.4 BLEU on the WMT 2014 English-to-German translation task.";
  const v = verify({ explanation: "It gets 28.4 BLEU, beating 30.1.", evidence: "Our model achieves 28.4 BLEU on the WMT 2014", key: "28.4 BLEU" }, src);
  console.assert(v.evidenceOk && v.keyOk && v.missingNumbers.join() === "30.1", "verify() self-check failed", v);
  const vb = verify({ explanation: "এটি ২৮.৪ BLEU পায়", evidence: "", key: "" }, src);
  console.assert(vb.numbers.join() === "28.4" && !vb.missingNumbers.length, "Bangla digits self-check failed", vb);
  const p = protect("The Transformer uses attention and gets 28.4 BLEU.");
  console.assert(p.terms.join("|") === "Transformer|attention|28.4|BLEU" && restore(p.text, p.terms) === "The Transformer uses attention and gets 28.4 BLEU.",
    "protect() self-check failed", p);
}
