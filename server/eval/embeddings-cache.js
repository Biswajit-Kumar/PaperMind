// Disk-cached embeddings for the eval harness. Keyed by sha256(text), so
// re-running the eval (after adding a strategy, tweaking a metric, etc.)
// costs zero new Gemini calls for text seen before - embed once, iterate
// offline forever.
//
// Talks to the Gemini API directly via @google/generative-ai rather than
// through @langchain/google-genai's GoogleGenerativeAIEmbeddings wrapper.
// That wrapper batches internally with Promise.allSettled and, on a
// rejected sub-batch (e.g. a 429), silently fills the slice with `[]`
// instead of throwing - so its own maxRetries never engages and a
// rate-limited call looks like a *successful* empty result (confirmed by
// calling model.batchEmbedContents directly: the real error is
// "429 Too Many Requests ... EmbedContentRequestsPerDayPerProjectPerModel-
// FreeTier ... Please retry in 53s" - a smooth token-bucket refill of a
// daily budget, not a hard until-tomorrow wall, and short enough that
// honoring Google's own suggested delay is far better than guessing).
import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, "results", "embeddings.cache.json");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });

// The API's own documented max items per batchEmbedContents call. Bigger
// batches = fewer quota-counted requests, which is what actually matters
// on a free tier this tight - one request costs the same whether it holds
// 1 document or 100.
const MAX_BATCH = 100;
// Floor between requests even on a clean run, no requests count as "free" -
// this alone would sustain ~1000/day if nothing ever failed.
const MIN_GAP_MS = 8000;

const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

let cache = loadCache();

function saveCache() {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isValidVector = (v) => Array.isArray(v) && v.length > 0 && typeof v[0] === "number";

// Google's 429 body includes its own suggested wait, e.g.
// "Please retry in 53.118839445s." - honor that exactly (plus a safety
// margin) instead of a guessed backoff schedule.
function parseRetryDelaySeconds(err) {
  const msg = err?.message || "";
  const m = msg.match(/retry in ([\d.]+)s/i);
  if (m) return parseFloat(m[1]);
  return null;
}

let lastRequestAt = 0;
async function pace() {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

const cleanText = (t) => t.replace(/\n/g, " ");

async function batchEmbedRaw(texts) {
  await pace();
  const res = await model.batchEmbedContents({
    requests: texts.map((t) => ({
      content: { role: "user", parts: [{ text: cleanText(t) }] },
    })),
  });
  return res.embeddings.map((e) => e.values || []);
}

async function embedBatchWithRetry(batch, attempt = 1) {
  try {
    const vectors = await batchEmbedRaw(batch);
    if (vectors.every(isValidVector)) return vectors;
    throw new Error("API returned a well-formed response but with an empty embedding vector");
  } catch (err) {
    if (attempt >= 8) {
      throw new Error(
        `Embedding batch failed after ${attempt} attempts: ${err.message}`,
      );
    }
    const suggested = parseRetryDelaySeconds(err);
    const waitMs = suggested ? Math.ceil(suggested * 1000) + 5000 : 15000 * attempt;
    console.error(
      `\n    batch failed (attempt ${attempt}/8: ${err.message.slice(0, 120)}) - retrying in ${Math.round(waitMs / 1000)}s`,
    );
    await sleep(waitMs);
    return embedBatchWithRetry(batch, attempt + 1);
  }
}

// Embeds a batch of document texts, hitting the cache first and only calling
// Gemini for the misses. Saves progressively so a crash mid-run doesn't lose
// already-embedded work. Batches at the API's own max size to minimize the
// number of quota-counted requests.
async function embedTexts(texts) {
  const results = new Array(texts.length);
  const missIdx = [];
  const missTexts = [];

  texts.forEach((t, i) => {
    const h = hash(t);
    if (isValidVector(cache[h])) {
      results[i] = cache[h];
    } else {
      missIdx.push(i);
      missTexts.push(t);
    }
  });

  for (let start = 0; start < missTexts.length; start += MAX_BATCH) {
    const batch = missTexts.slice(start, start + MAX_BATCH);
    const vectors = await embedBatchWithRetry(batch);
    vectors.forEach((v, bi) => {
      const idx = missIdx[start + bi];
      results[idx] = v;
      cache[hash(missTexts[start + bi])] = v;
    });
    saveCache();
    process.stdout.write(
      `\r    embedded ${Math.min(start + MAX_BATCH, missTexts.length)}/${missTexts.length} new chunks`,
    );
  }
  if (missTexts.length > 0) process.stdout.write("\n");

  return results;
}

// Queries use a separate cache namespace ("Q::" prefix) from document text,
// since the same string embedded as a query vs. a document could in
// principle produce different vectors (task-type-aware embedding models).
//
// Batches ALL not-yet-cached questions into as few requests as possible -
// call this once up front before running any strategy, so embedQuery()
// below is always a pure cache read during the actual eval loop instead of
// spending one request per question per strategy.
async function embedQueriesBatch(texts) {
  const misses = [];
  for (const t of texts) {
    const h = hash("Q::" + t);
    if (!isValidVector(cache[h])) misses.push(t);
  }
  if (misses.length === 0) return;

  for (let start = 0; start < misses.length; start += MAX_BATCH) {
    const batch = misses.slice(start, start + MAX_BATCH);
    const vectors = await embedBatchWithRetry(batch);
    vectors.forEach((v, i) => {
      cache[hash("Q::" + batch[i])] = v;
    });
    saveCache();
  }
}

async function embedQuery(text) {
  const h = hash("Q::" + text);
  if (isValidVector(cache[h])) return cache[h];
  // Fallback for any query not pre-warmed by embedQueriesBatch.
  const [v] = await embedBatchWithRetry([text]);
  cache[h] = v;
  saveCache();
  return v;
}

function cosineSim(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

export { embedTexts, embedQuery, embedQueriesBatch, cosineSim };
