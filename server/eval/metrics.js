// Relevance judging and retrieval metrics for the eval harness.
//
// "Is this retrieved chunk relevant to this question?" is decided by token
// overlap between the chunk and the question's gold quote(s), not exact
// substring matching - PDF extraction reflows whitespace/hyphenation, so an
// exact-match check would under-count genuinely correct retrievals.

const tokenize = (text) =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2), // drop stopword-length noise
  );

const OVERLAP_THRESHOLD = 0.6;

// Fraction of the gold quote's distinctive words found in the chunk.
function overlapRatio(chunkText, goldQuote) {
  const goldTokens = tokenize(goldQuote);
  if (goldTokens.size === 0) return 0;
  const chunkTokens = tokenize(chunkText);
  let hit = 0;
  for (const t of goldTokens) if (chunkTokens.has(t)) hit++;
  return hit / goldTokens.size;
}

// A chunk counts as relevant to a question if it's from the right document
// and page AND clears the overlap threshold against any of the question's
// gold quotes - page match alone isn't enough (a chunk could be from the
// right page but an unrelated part of it), and overlap alone isn't enough
// (a different document could coincidentally share vocabulary).
function isRelevant(chunk, question) {
  if (chunk.doc !== question.doc) return false;
  const quotes = [question.gold_quote, question.gold_quote_2].filter(Boolean);
  return quotes.some(
    (q) => overlapRatio(chunk.content, q) >= OVERLAP_THRESHOLD,
  );
}

// results: chunks sorted best-to-worst for one question, each carrying
// { content, doc, page }. Returns per-question hit@k (k in ks) and the
// reciprocal rank of the first relevant chunk (0 if none in the ranked list).
function scoreQuestion(rankedChunks, question, ks) {
  let firstRelevantRank = null;
  const relevantAt = [];
  rankedChunks.forEach((chunk, i) => {
    const rel = isRelevant(chunk, question);
    relevantAt.push(rel);
    if (rel && firstRelevantRank === null) firstRelevantRank = i + 1;
  });

  const hitAtK = {};
  for (const k of ks) {
    hitAtK[k] = relevantAt.slice(0, k).some(Boolean) ? 1 : 0;
  }

  return {
    hitAtK,
    reciprocalRank: firstRelevantRank ? 1 / firstRelevantRank : 0,
  };
}

// Aggregates per-question scores into the summary numbers reported per
// strategy: hit-rate@k (% of questions with a relevant chunk in the top k)
// and MRR (mean reciprocal rank).
function aggregate(perQuestionScores, ks) {
  const n = perQuestionScores.length || 1;
  const hitRateAtK = {};
  for (const k of ks) {
    hitRateAtK[k] =
      perQuestionScores.reduce((sum, s) => sum + s.hitAtK[k], 0) / n;
  }
  const mrr =
    perQuestionScores.reduce((sum, s) => sum + s.reciprocalRank, 0) / n;
  return { hitRateAtK, mrr, n: perQuestionScores.length };
}

export { isRelevant, overlapRatio, scoreQuestion, aggregate, OVERLAP_THRESHOLD };
