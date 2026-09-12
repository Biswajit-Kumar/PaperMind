import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { TextLoader } from "langchain/document_loaders/fs/text";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

// Rough token estimate (~4 chars/token for English prose). Kept local rather
// than imported from embeddings.service.js to avoid a circular import.
const approxTokens = (text) => Math.ceil(text.length / 4);

// Load a document into *page-aware segments*. A PDF comes back as one segment
// per page (PDFLoader already splits pages by default), so a chunk built from
// it can later be cited as "p. 42". Formats with no real page concept (.txt,
// .md) come back as a single segment with page: null.
const loadDocument = async (filePath, mimeType) => {
  let loader;

  switch (mimeType) {
    case "application/pdf":
      loader = new PDFLoader(filePath);
      break;
    case "text/plain":
    case "text/markdown":
      loader = new TextLoader(filePath);
      break;
    default:
      throw new Error(`Unsupported file type: ${mimeType}`);
  }

  const docs = await loader.load();

  if (!docs || docs.length === 0) {
    throw new Error("No content found in document");
  }

  const isPdf = mimeType === "application/pdf";

  const segments = docs
    .map((doc, i) => ({
      content: doc.pageContent,
      // PDFLoader stores the 1-based page number at metadata.loc.pageNumber;
      // fall back to document order if a loader ever omits it.
      page: isPdf ? (doc.metadata?.loc?.pageNumber ?? i + 1) : null,
    }))
    .filter((s) => s.content && s.content.trim().length > 0);

  const text = segments
    .map((s) => s.content)
    .join("\n\n")
    .trim();

  if (!text || text.length < 10) {
    throw new Error("No readable text found in document");
  }

  return { text, segments };
};

// Back-compat wrapper for callers that only need the flat extracted text
// (credit estimation, storing Content.extractedText).
const processDocument = async (filePath, mimeType) => {
  const { text } = await loadDocument(filePath, mimeType);
  return text;
};

// Split page-aware segments into chunks. Two things differ from a naive
// splitText():
//   1. Each segment is split independently, so a chunk never straddles a page
//      boundary and always carries exactly one page number.
//   2. Chunk size is measured in approximate *tokens*, not raw characters, so
//      chunk sizes line up with what the embedding and chat models actually
//      consume (a 1000-char chunk of dense text is ~350 tokens; of sparse
//      text ~150 - measuring in tokens keeps that consistent).
const splitSegmentsIntoChunks = async (segments, options = {}) => {
  const {
    chunkTokens = parseInt(process.env.CHUNK_TOKENS) || 300,
    chunkOverlapTokens = parseInt(process.env.CHUNK_OVERLAP_TOKENS) || 50,
  } = options;

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: chunkTokens,
    chunkOverlap: chunkOverlapTokens,
    lengthFunction: approxTokens,
  });

  const texts = segments.map((s) => s.content);
  const metadatas = segments.map((s) => ({ page: s.page }));

  // createDocuments splits each text and pairs it with the matching metadata.
  const docs = await splitter.createDocuments(texts, metadatas);

  return docs
    .filter((doc) => doc.pageContent.trim().length > 0)
    .map((doc, index) => ({
      content: doc.pageContent,
      page: doc.metadata?.page ?? null,
      chunkIndex: index,
    }));
};

// Back-compat splitter for sources with no page structure (raw text, scraped
// URLs, YouTube transcripts). Returns the same chunk-object shape as
// splitSegmentsIntoChunks.
const splitTextIntoChunks = async (text, options = {}) => {
  return splitSegmentsIntoChunks([{ content: text, page: null }], options);
};

export {
  loadDocument,
  processDocument,
  splitSegmentsIntoChunks,
  splitTextIntoChunks,
};
