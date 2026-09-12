import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { PromptTemplate } from "@langchain/core/prompts";
import { searchMultipleSources } from "./qdrant.service.js";
import { estimateTokens } from "./embeddings.service.js";

const llm = new ChatGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
  model: "gemini-flash-latest",
  temperature: 0.1,
  // Gemini's free tier returns 503 "high demand" intermittently. Retry with
  // exponential backoff (LangChain's AsyncCaller handles the backoff) so a
  // transient spike doesn't drop the user's answer.
  maxRetries: 4,
});

// Each retrieved chunk is presented as a numbered source [1], [2], ... labelled
// with its real document title and page. The model is told to cite inline with
// those exact markers, which lets us report back only the sources it actually
// used (see referencedIndexes below) instead of dumping every chunk we fetched.
const ragPromptTemplate = PromptTemplate.fromTemplate(`
You are a helpful AI assistant that answers questions using ONLY the numbered sources below.

Sources:
{context}

Question: {question}

Instructions:
1. Answer using ONLY the information in the numbered sources above.
2. After every sentence or claim that uses a source, add its marker in square brackets, e.g. "The revenue grew 12% [2]." Cite every source you rely on; you may cite more than one like [1][3].
3. Do NOT cite a source you did not use. Do NOT invent markers.
4. If the sources do not contain enough information, reply exactly: "I don't have enough information in the provided documents to answer this question." and cite nothing.
5. Keep the answer clear and concise.

Answer:
`);

// Pull every [n] / [n, m] / [n][m] marker out of the model's answer.
const referencedIndexes = (text) => {
  const found = new Set();
  const matches = text.matchAll(/\[([\d,\s]+)\]/g);
  for (const m of matches) {
    for (const part of m[1].split(",")) {
      const n = parseInt(part.trim(), 10);
      if (!Number.isNaN(n)) found.add(n);
    }
  }
  return found;
};

const processQuery = async (query, selectedContentIds) => {
  try {
    if (!query || query.trim().length === 0) {
      throw new Error("Query is required");
    }

    if (!selectedContentIds || selectedContentIds.length === 0) {
      throw new Error("At least one content source must be selected");
    }

    // Retrieve relevant chunks (already score-filtered in qdrant.service).
    const searchResults = await searchMultipleSources(selectedContentIds, query);

    if (searchResults.length === 0) {
      return {
        response:
          "I couldn't find any relevant information in your selected documents to answer this question. Try rephrasing your question or selecting different documents.",
        citations: [],
        tokensUsed: { input: 0, output: 0, total: 0 },
      };
    }

    // Build the numbered source list. 1-based markers so they read naturally
    // in the answer.
    const context = searchResults
      .map((result, i) => {
        const title = result.metadata.title || "Untitled source";
        const page = result.metadata.page;
        const where = page ? `${title}, p. ${page}` : title;
        return `[${i + 1}] (${where})\n${result.content}`;
      })
      .join("\n\n---\n\n");

    const prompt = await ragPromptTemplate.format({ context, question: query });

    const inputTokens = estimateTokens(prompt);

    const response = await llm.invoke(prompt);
    const responseText = response.content;

    const outputTokens = estimateTokens(responseText);
    const totalTokens = inputTokens + outputTokens;

    // Only report the sources the model actually cited, rather than listing
    // every chunk we retrieved. Two special cases:
    //  - the model answered "not enough information" -> cite nothing.
    //  - the model answered but emitted no markers (didn't follow the format)
    //    -> fall back to all retrieved chunks so the user still gets sources.
    const used = referencedIndexes(responseText);
    const saidNoInfo = /don't have enough information/i.test(responseText);
    const includeAll = used.size === 0 && !saidNoInfo;

    const citations = searchResults
      .map((result, i) => ({ result, marker: i + 1 }))
      .filter(({ marker }) => includeAll || used.has(marker))
      .map(({ result, marker }) => ({
        marker,
        contentId: result.metadata.contentId,
        chunkIndex: result.metadata.chunkIndex,
        page: result.metadata.page ?? null,
        title: result.metadata.title || `Source ${marker}`,
        sourceType: result.metadata.sourceType || "unknown",
        content:
          result.content.substring(0, 200) +
          (result.content.length > 200 ? "..." : ""),
        relevanceScore: result.score,
      }));

    return {
      response: responseText,
      citations,
      // Chunks we retrieved but the model did not cite - handy for debugging
      // retrieval quality without cluttering the user-facing citation list.
      retrievedCount: searchResults.length,
      tokensUsed: {
        input: inputTokens,
        output: outputTokens,
        total: totalTokens,
      },
    };
  } catch (error) {
    // Surface Gemini overload as a clear, retryable message rather than a
    // generic 500 with a stack trace.
    if (
      /503|high demand|overloaded|unavailable/i.test(error.message || "")
    ) {
      throw new Error(
        "The AI service is temporarily overloaded. Please try again in a moment.",
      );
    }
    throw new Error(`Error processing query: ${error.message}`);
  }
};

export { processQuery };
