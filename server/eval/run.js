// Eval harness CLI. Retrieval is pooled across all 3 papers per strategy
// (not scoped to the question's own document) - a question's query has to
// out-rank chunks from two unrelated papers to score a hit, which exercises
// real cross-document discrimination the way a multi-source notebook would,
// rather than the easier single-document-search case.
//
// Usage: node eval/run.js  (needs GEMINI_API_KEY and network access to
// Gemini - run on a connection that isn't blocking it, see the project's
// notes on the hostel-WiFi proxy issue if embedding calls time out)
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { STRATEGIES } from "./strategies.js";
import { embedTexts, embedQuery, embedQueriesBatch, cosineSim } from "./embeddings-cache.js";
import { scoreQuestion, aggregate } from "./metrics.js";
import { rerank } from "./rerank.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const K_VALUES = [1, 3, 5, 10];
const TOP_K_RETRIEVE = 10;
const RERANK_POOL = 20;

function loadDataset() {
  const raw = fs.readFileSync(path.join(__dirname, "dataset.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadPages(doc) {
  const p = path.join(__dirname, "datasets", "papers", `${doc}.pages.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function buildChunksForStrategy(name, docs) {
  const strategy = STRATEGIES[name];
  const allChunks = [];
  for (const doc of docs) {
    const pages = loadPages(doc);
    const chunks = strategy.needsEmbedder
      ? await strategy.fn(pages, { embedTexts, cosineSim })
      : await strategy.fn(pages);
    for (const c of chunks) allChunks.push({ ...c, doc });
  }
  return allChunks;
}

async function embedChunks(chunks) {
  const vectors = await embedTexts(chunks.map((c) => c.content));
  return chunks.map((c, i) => ({ ...c, vector: vectors[i] }));
}

function rankByCosine(queryVec, embeddedChunks, limit) {
  return embeddedChunks
    .map((c) => ({ ...c, score: cosineSim(queryVec, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function runStrategy(name, questions, docs) {
  console.log(`\n=== ${STRATEGIES[name].label} ===`);
  const chunks = await buildChunksForStrategy(name, docs);
  console.log(`  ${chunks.length} chunks across ${docs.length} documents`);
  const embedded = await embedChunks(chunks);

  const perQuestion = [];
  for (const q of questions) {
    const qVec = await embedQuery(q.question);
    const ranked = rankByCosine(qVec, embedded, TOP_K_RETRIEVE);
    perQuestion.push(scoreQuestion(ranked, q, K_VALUES));
  }
  return { chunkCount: chunks.length, ...aggregate(perQuestion, K_VALUES) };
}

async function runRerankOnTopOf(baseName, questions, docs) {
  console.log(`\n=== ${STRATEGIES[baseName].label} + Gemini re-rank ===`);
  const chunks = await buildChunksForStrategy(baseName, docs);
  const embedded = await embedChunks(chunks);

  const perQuestion = [];
  let rerankedCount = 0;
  for (const q of questions) {
    const qVec = await embedQuery(q.question);
    const candidates = rankByCosine(qVec, embedded, RERANK_POOL);
    const { chunks: reranked, reranked: didRerank } = await rerank(
      q.question,
      candidates,
      TOP_K_RETRIEVE,
    );
    if (didRerank) rerankedCount++;
    perQuestion.push(scoreQuestion(reranked, q, K_VALUES));
    process.stdout.write(".");
  }
  console.log("");

  // If the reranker never actually succeeded once (e.g. the free-tier daily
  // quota for the chat model was already spent), every "reranked" result is
  // really just the vector-order fallback - report that plainly rather than
  // publishing numbers that look like a reranked result but aren't one.
  if (rerankedCount === 0) {
    console.log(
      `  Gemini re-rank never succeeded (0/${questions.length} calls) - likely the free-tier daily quota for the chat model is exhausted. Skipping this row rather than reporting fallback numbers as if they were reranked.`,
    );
    return null;
  }
  if (rerankedCount < questions.length) {
    console.log(
      `  Note: re-rank only succeeded on ${rerankedCount}/${questions.length} questions; the rest fell back to vector order.`,
    );
  }

  return { chunkCount: chunks.length, rerankedCount, ...aggregate(perQuestion, K_VALUES) };
}

const fmtPct = (x) => (x * 100).toFixed(0) + "%";

async function main() {
  const questions = loadDataset();
  const docs = [...new Set(questions.map((q) => q.doc))];
  console.log(
    `Loaded ${questions.length} questions across ${docs.length} documents: ${docs.join(", ")}`,
  );

  // Pre-warm all query embeddings in one batched call, so the per-strategy
  // loops below (which call embedQuery once per question) are pure cache
  // reads instead of spending one quota-counted request per question - the
  // free-tier daily budget is tight enough that this matters.
  console.log("Pre-embedding all questions in one batch...");
  await embedQueriesBatch(questions.map((q) => q.question));

  const runs = [
    ["fixed-no-overlap", "Fixed 300-token, no overlap"],
    ["fixed-overlap", "Fixed 300-token, 50-token overlap"],
    ["recursive", "Recursive split (production)"],
    ["semantic", "Semantic chunking"],
  ];

  // A single strategy failing (typically the daily embedding quota running
  // out mid-run) shouldn't throw away every other strategy's real, already-
  // paid-for results - catch per-strategy and keep going, noting the gap.
  const results = {};
  const failed = [];
  for (const [key, label] of runs) {
    try {
      results[key] = await runStrategy(key, questions, docs);
    } catch (err) {
      console.log(`  ${label} FAILED: ${err.message.split("\n")[0]}`);
      failed.push({ key, label, reason: err.message.split("\n")[0] });
    }
  }

  let rerankResult = null;
  if (results.recursive) {
    try {
      rerankResult = await runRerankOnTopOf("recursive", questions, docs);
    } catch (err) {
      console.log(`  Recursive + Gemini re-rank FAILED: ${err.message.split("\n")[0]}`);
      failed.push({
        key: "recursive-rerank",
        label: "Recursive split + Gemini re-rank",
        reason: err.message.split("\n")[0],
      });
    }
  }
  if (rerankResult) {
    results["recursive-rerank"] = rerankResult;
    runs.push(["recursive-rerank", "Recursive split + Gemini re-rank"]);
  }

  let table =
    "| Chunking strategy | Hit@1 | Hit@3 | Hit@5 | Hit@10 | MRR@10 |\n";
  table += "|---|---|---|---|---|---|\n";
  for (const [key, label] of runs) {
    const r = results[key];
    if (!r) continue;
    table += `| ${label} | ${fmtPct(r.hitRateAtK[1])} | ${fmtPct(r.hitRateAtK[3])} | ${fmtPct(r.hitRateAtK[5])} | ${fmtPct(r.hitRateAtK[10])} | ${r.mrr.toFixed(2)} |\n`;
  }
  if (results.recursive && !rerankResult && !failed.some((f) => f.key === "recursive-rerank")) {
    table +=
      "\n_Re-ranker row omitted this run: the free-tier daily quota for the chat model was already spent, so 0 rerank calls actually succeeded. Re-run later to add it._\n";
  }
  for (const f of failed) {
    table += `\n_${f.label} row omitted this run: ${f.reason} - re-run later once the daily quota resets._\n`;
  }

  console.log("\n\n=== SUMMARY ===\n");
  console.log(table);

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(outDir, `${timestamp}.json`),
    JSON.stringify({ questionCount: questions.length, docs, results, failed }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Retrieval evaluation results\n\nGenerated ${new Date().toISOString()}\n` +
      `Questions: ${questions.length} across ${docs.length} documents (${docs.join(", ")})\n\n${table}`,
  );
  console.log(`Saved to eval/results/${timestamp}.json and eval/results/summary.md`);
}

main().catch((err) => {
  console.error("Eval run failed:", err);
  process.exit(1);
});
