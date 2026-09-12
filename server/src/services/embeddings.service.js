import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import {
  splitSegmentsIntoChunks,
  splitTextIntoChunks,
} from "./document.processor.service.js";
import { addDocuments } from "./qdrant.service.js";

const embeddings = new GoogleGenerativeAIEmbeddings({
  apiKey: process.env.GEMINI_API_KEY,
  model: "gemini-embedding-001",
  // Retry transient 503/429s from Gemini's free tier during ingestion.
  maxRetries: 3,
});

// Accepts either page-aware segments ([{ content, page }], from a PDF) or a
// plain string (raw text / scraped URL / YouTube transcript). Chunks it,
// preserving page numbers where they exist, then embeds + stores each chunk.
const processAndEmbed = async (contentId, source, metadata = {}) => {
  try {
    const chunks = Array.isArray(source)
      ? await splitSegmentsIntoChunks(source)
      : await splitTextIntoChunks(source);

    if (chunks.length === 0) {
      throw new Error("No chunks created from text");
    }

    // Add documents to Qdrant (embeddings created automatically)
    const result = await addDocuments(contentId, chunks, metadata);

    const fullText = Array.isArray(source)
      ? source.map((s) => s.content).join("\n\n")
      : source;
    const totalTokens = estimateTokens(fullText);

    return {
      collectionName: result.collectionName,
      chunkCount: result.chunkCount,
      tokensUsed: totalTokens,
    };
  } catch (error) {
    throw new Error(`Error processing and embedding text: ${error.message}`);
  }
};

const estimateTokens = (text) => {
  // Rough estimate: ~4 characters per token for English text
  const charsPerToken = parseInt(process.env.CHARACTERS_PER_TOKEN) || 4;
  return Math.ceil(text.length / charsPerToken);
};

// Calculate credits needed (1000 tokens = 1 credit)
const calculateCredits = (tokens) => {
  const tokensPerCredit = parseInt(process.env.TOKENS_PER_CREDIT) || 1000;
  return tokens / tokensPerCredit;
};

export { processAndEmbed, estimateTokens, calculateCredits, embeddings };
