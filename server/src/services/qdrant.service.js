import { QdrantVectorStore } from "@langchain/qdrant";
import { QdrantClient } from "@qdrant/js-client-rest";
import { embeddings } from "./embeddings.service.js";

const qdrantUrl =
  process.env.QDRANT_URL ||
  `http://${process.env.QDRANT_HOST || "localhost"}:${
    process.env.QDRANT_PORT || 6333
  }`;

// Shared client with checkCompatibility disabled - the bundled qdrant-js
// (1.15) is a minor version behind the Docker image (1.18) and logs a scary
// "incompatible" warning on every call, though every operation we use works
// fine across that gap.
const qdrantClient = new QdrantClient({
  url: qdrantUrl,
  apiKey: process.env.QDRANT_API_KEY || undefined,
  checkCompatibility: false,
});

const qdrantConfig = { client: qdrantClient };

// How many chunks to retrieve, and the minimum cosine similarity a chunk must
// clear to be handed to the LLM. The threshold stops an off-topic document
// from injecting its "least bad" chunks into the context just because it was
// selected. Tune RAG_MIN_SCORE per embedding model if recall feels low.
const TOP_K = parseInt(process.env.RAG_TOP_K) || 5;
const MIN_SCORE = parseFloat(process.env.RAG_MIN_SCORE || "0.3");

const addDocuments = async (contentId, chunks, metadata = {}) => {
  try {
    const collectionName = `content_${contentId}`;

    // chunks: [{ content, page, chunkIndex }] from the document processor.
    const documents = chunks.map((chunk, index) => ({
      pageContent: chunk.content,
      metadata: {
        contentId,
        chunkIndex: chunk.chunkIndex ?? index,
        page: chunk.page ?? null,
        ...metadata,
      },
    }));

    // Create vector store and add documents (collection created automatically)
    const vectorStore = await QdrantVectorStore.fromDocuments(
      documents,
      embeddings,
      {
        ...qdrantConfig,
        collectionName,
      }
    );

    return {
      collectionName,
      chunkCount: chunks.length,
      vectorStore,
    };
  } catch (error) {
    throw new Error(`Error adding documents to Qdrant: ${error.message}`);
  }
};

// Search one content collection. Returns scored chunks already filtered by
// MIN_SCORE.
const searchSimilar = async (contentId, query, limit = TOP_K) => {
  try {
    const collectionName = `content_${contentId}`;

    const vectorStore = new QdrantVectorStore(embeddings, {
      ...qdrantConfig,
      collectionName,
    });

    const results = await vectorStore.similaritySearchWithScore(query, limit);

    return results
      .map(([doc, score]) => ({
        content: doc.pageContent,
        score,
        metadata: doc.metadata,
      }))
      .filter((r) => r.score >= MIN_SCORE);
  } catch (error) {
    throw new Error(`Error searching documents: ${error.message}`);
  }
};

// Search across multiple content collections (multi-source selection), merge,
// keep only the globally top-K chunks that clear the score threshold.
const searchMultipleSources = async (contentIds, query, limit = TOP_K) => {
  try {
    const allResults = [];

    for (const contentId of contentIds) {
      try {
        // Over-fetch per source, then trim globally, so one strong source can
        // still supply most of the context.
        const results = await searchSimilar(contentId, query, limit);
        allResults.push(...results);
      } catch (error) {
        console.log(`No results from content ${contentId}: ${error.message}`);
      }
    }

    // Higher cosine similarity = better match
    allResults.sort((a, b) => b.score - a.score);

    return allResults.slice(0, limit);
  } catch (error) {
    throw new Error(`Error searching multiple sources: ${error.message}`);
  }
};

// Delete collection
const deleteCollection = async (contentId) => {
  try {
    await qdrantClient.deleteCollection(`content_${contentId}`);
    return true;
  } catch (error) {
    console.log(`Error deleting collection: ${error.message}`);
    return false;
  }
};

export { addDocuments, searchSimilar, searchMultipleSources, deleteCollection };
