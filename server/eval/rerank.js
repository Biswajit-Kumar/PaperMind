// Listwise re-ranking via Gemini, used as the "+ re-ranker" row on top of the
// best chunking strategy. A real cross-encoder (e.g. bge-reranker) is the
// textbook choice, but it needs a multi-hundred-MB ONNX model download,
// which is exactly the kind of thing this project's network has struggled
// with (see the hostel-WiFi proxy notes elsewhere) - Gemini reranking needs
// no new infra and still gives a real, reproducible number.
import "dotenv/config";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

const llm = new ChatGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
  // gemini-flash-latest (-> gemini-3.8-flash) has only a 20-requests/day
  // free-tier quota - confirmed by this very reranker hitting it during
  // eval development. gemini-flash-lite-latest has its own, separate, far
  // less constrained quota bucket - see the matching note in
  // src/services/chat.service.js.
  model: "gemini-flash-lite-latest",
  temperature: 0,
  maxRetries: 3,
});

// candidates: chunks already sorted by vector similarity (best first).
// Returns the same chunks reordered by relevance to the query, per Gemini.
async function rerank(query, candidates, topN) {
  if (candidates.length === 0) return { chunks: candidates, reranked: false };

  const listing = candidates
    .map((c, i) => `[${i + 1}] ${c.content.slice(0, 400)}`)
    .join("\n\n");

  const prompt = `Question: ${query}

Below are ${candidates.length} numbered passages retrieved for this question. Rank them from MOST to LEAST relevant to answering the question.

${listing}

Reply with ONLY a comma-separated list of the passage numbers, most relevant first, e.g.: 3,1,5,2,4`;

  try {
    const response = await llm.invoke(prompt);
    const order = String(response.content)
      .match(/\d+/g)
      ?.map(Number)
      .filter((n) => n >= 1 && n <= candidates.length);

    if (!order || order.length === 0) {
      return { chunks: candidates.slice(0, topN), reranked: false };
    }

    const seen = new Set();
    const reordered = [];
    for (const n of order) {
      if (!seen.has(n)) {
        seen.add(n);
        reordered.push(candidates[n - 1]);
      }
    }
    // Append anything Gemini's response omitted, preserving original order.
    candidates.forEach((c, i) => {
      if (!seen.has(i + 1)) reordered.push(c);
    });

    return { chunks: reordered.slice(0, topN), reranked: true };
  } catch (err) {
    console.error(`  rerank failed (${err.message}), falling back to vector order`);
    return { chunks: candidates.slice(0, topN), reranked: false };
  }
}

export { rerank };
