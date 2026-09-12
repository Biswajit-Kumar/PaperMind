// Chunking strategies compared by the eval. Each takes the same input -
// per-page segments [{ page, text }] for one paper - and returns
// [{ content, page }] chunks. Chunk *size* is held constant (~300 tokens,
// matching production) across strategies so the comparison isolates the
// splitting *method*, not a size difference.
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const approxTokens = (text) => Math.ceil(text.length / 4);
const CHUNK_TOKENS = 300;
const OVERLAP_TOKENS = 50;
// Rough chars-per-token used only by the strategies that cut blindly by
// character count (the "fixed" baselines) rather than a real tokenizer.
const CHARS_PER_CHUNK = CHUNK_TOKENS * 4;
const OVERLAP_CHARS = OVERLAP_TOKENS * 4;

// Baseline 1: blind fixed-length character windows, no overlap, no regard
// for sentence/paragraph boundaries - the naive chunking most tutorials start
// with, and the worst-case reference point for the comparison.
function fixedNoOverlap(segments) {
  const chunks = [];
  for (const { page, text } of segments) {
    for (let i = 0; i < text.length; i += CHARS_PER_CHUNK) {
      const content = text.slice(i, i + CHARS_PER_CHUNK).trim();
      if (content) chunks.push({ content, page });
    }
  }
  return chunks;
}

// Baseline 2: same blind fixed-length cut, but with overlap between
// consecutive windows - the common "quick fix" for baseline 1's boundary
// problem (a fact split exactly across two chunks becomes unretrievable).
function fixedWithOverlap(segments) {
  const chunks = [];
  const step = CHARS_PER_CHUNK - OVERLAP_CHARS;
  for (const { page, text } of segments) {
    for (let i = 0; i < text.length; i += step) {
      const content = text.slice(i, i + CHARS_PER_CHUNK).trim();
      if (content) chunks.push({ content, page });
      if (i + CHARS_PER_CHUNK >= text.length) break;
    }
  }
  return chunks;
}

// Production strategy: RecursiveCharacterTextSplitter with a token-based
// length function, split per-page (see document.processor.service.js).
// Respects paragraph/sentence/word boundaries via its separator hierarchy
// instead of cutting mid-word.
async function recursive(segments) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_TOKENS,
    chunkOverlap: OVERLAP_TOKENS,
    lengthFunction: approxTokens,
  });
  const texts = segments.map((s) => s.text);
  const metadatas = segments.map((s) => ({ page: s.page }));
  const docs = await splitter.createDocuments(texts, metadatas);
  return docs
    .filter((d) => d.pageContent.trim().length > 0)
    .map((d) => ({ content: d.pageContent, page: d.metadata.page }));
}

// Semantic chunking: split into sentences, embed a small rolling window
// around each sentence, and cut a new chunk wherever consecutive windows'
// cosine similarity drops sharply (a statistical breakpoint, not a fixed
// separator) - Greg Kamradt's percentile/std-dev breakpoint method. Requires
// embedding many small pieces, so it's the most expensive strategy to build.
async function semantic(segments, { embedTexts, cosineSim }) {
  const chunks = [];

  // Embedding is what's scarce here (a tight free-tier daily quota, one
  // request per call regardless of how many items it holds) - so build
  // every page's sentence-windows first and embed them all in ONE call for
  // the whole paper, instead of one embedTexts call per page.
  const perPage = segments.map(({ page, text }) => {
    const sentences = text
      .split(/(?<=[.!?])\s+(?=[A-Z(])/)
      .map((s) => s.trim())
      .filter(Boolean);
    const windows = sentences.map((_, i) => sentences.slice(i, i + 3).join(" "));
    return { page, text, sentences, windows };
  });

  const allWindows = perPage.flatMap((p) => p.windows);
  const allVectors = allWindows.length > 0 ? await embedTexts(allWindows) : [];

  let cursor = 0;
  for (const { page, text, sentences, windows } of perPage) {
    const vectors = allVectors.slice(cursor, cursor + windows.length);
    cursor += windows.length;

    if (sentences.length <= 1) {
      if (text.trim()) chunks.push({ content: text.trim(), page });
      continue;
    }

    const sims = [];
    for (let i = 0; i < vectors.length - 1; i++) {
      sims.push(cosineSim(vectors[i], vectors[i + 1]));
    }

    // Breakpoint where similarity drops more than 1 std dev below the mean -
    // i.e. a bigger topic shift than usual for this page.
    const mean = sims.reduce((a, b) => a + b, 0) / (sims.length || 1);
    const variance =
      sims.reduce((a, b) => a + (b - mean) ** 2, 0) / (sims.length || 1);
    const threshold = mean - Math.sqrt(variance);

    let current = [sentences[0]];
    for (let i = 0; i < sims.length; i++) {
      if (sims[i] < threshold && approxTokens(current.join(" ")) > 40) {
        chunks.push({ content: current.join(" "), page });
        current = [];
      }
      current.push(sentences[i + 1]);
    }
    if (current.length > 0) chunks.push({ content: current.join(" "), page });
  }

  // A semantic breakpoint can still produce an oversized chunk (a long,
  // topically-consistent passage) - re-split anything over budget with the
  // same recursive splitter used elsewhere, so no chunk blows past the
  // context window the retrieval step assumes.
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_TOKENS,
    chunkOverlap: OVERLAP_TOKENS,
    lengthFunction: approxTokens,
  });
  const final = [];
  for (const c of chunks) {
    if (approxTokens(c.content) <= CHUNK_TOKENS * 1.3) {
      final.push(c);
    } else {
      const docs = await splitter.createDocuments([c.content], [{ page: c.page }]);
      for (const d of docs) final.push({ content: d.pageContent, page: c.page });
    }
  }
  return final;
}

const STRATEGIES = {
  "fixed-no-overlap": { label: "Fixed 300-token, no overlap", fn: fixedNoOverlap, needsEmbedder: false },
  "fixed-overlap": { label: "Fixed 300-token, 50-token overlap", fn: fixedWithOverlap, needsEmbedder: false },
  recursive: { label: "Recursive split (production)", fn: recursive, needsEmbedder: false },
  semantic: { label: "Semantic chunking", fn: semantic, needsEmbedder: true },
};

export { STRATEGIES, approxTokens };
