# PaperMind — completion plan

Four workstreams. 1 and 2 are credibility fixes (small, do first). 3 is the
recruiter headline. 4 hardens it and produces a second set of numbers.

Status legend: ☐ not started · ◐ in progress · ☑ done

---

## Workstream 1 — Credit system: lazy monthly reset  ☑

**Goal:** no more permanent dead-end when credits hit zero; keep abuse
protection on the live deploy; gain a "quota system" talking point.

| File | Change | Status |
|---|---|---|
| `server/src/model/User.model.js` | `credits` default `300 → 500`; add `creditsResetAt: { type: Date, default: Date.now }` | ☐ |
| `server/src/controller/user.controller.js` | Helper `refillCreditsIfDue(user)` — if `now - creditsResetAt >= 30d`: `credits = Math.max(credits, 500)`, `creditsResetAt = now`, save. Call in `login`, `googleAuthUser`, `getProfile`. | ☐ |
| `server/src/controller/user.controller.js` → `getUserStats` | Also return `creditsResetAt` and computed `nextResetAt` | ☐ |
| `client/src/pages/StatsPage.jsx` | Show "Credits reset on {date}" | ☐ |

**Notes:** `Math.max(credits, 500)` — never reset a light user *downward*.
Rolling 30-day window from last refill, not calendar month — no cron, no
month-boundary edge cases.

**Effort:** ~1 hr.

---

## Workstream 2 — Remove the fake dashboard stats  ☑

**Problem:** `client/src/pages/StatsPage.jsx` (~line 40, `// For DEMO Purpose`)
hardcodes `totalQueries: 156`, `1.3M tokens`, `42 documents`,
`89 credits last month`, `12.3/day`. A recruiter on a fresh account sees
fabricated activity — worse than no stats page.

**Fix — wire to real data** (already persisted in `ChatMessage` + `Content`):

| Stat | Real source |
|---|---|
| Total queries | `ChatMessage.countDocuments({ userId, role: "user" })` |
| Total tokens processed | `$sum` `ChatMessage.tokensUsed.total` + `$sum` `Content.tokensUsed` |
| Documents processed | `Content.countDocuments({ userId, status: "completed" })` |
| Favorite source type | `Content` aggregate: group by `sourceType`, sort desc, first |
| Avg credits / query | mean of `ChatMessage.creditsDeducted` |
| Avg queries / day | totalQueries ÷ days since `user.createdAt` |
| This / last month credits | `ChatMessage` aggregate on `createdAt`, `$sum creditsDeducted` by month (label "query credits" — upload credits aren't per-event logged) |

- Backend: extend `getUserStats` or add `GET /api/users/stats/detailed`.
- Frontend: delete the `detailedStats` mock, consume the endpoint. Any card
  that can't be honestly backed → remove it, don't fake it.

**Effort:** 3–4 hrs.

---

## Workstream 3 — Evaluation harness (headline)  ◐

**Actual scope shipped (smaller than originally planned, deliberately):** 3
papers (Attention, BERT, RAG — LoRA/DPR dropped to keep the free-tier
embedding quota affordable), 30 questions (10/paper) instead of 50. Harness,
dataset, and metrics are real and running; see `server/eval/results/summary.md`
for the current numbers.

**Real (not simulated) result so far — 3 of 4 base strategies + the
re-ranker, on 30 questions pooled across all 3 papers:**

| Chunking strategy | Hit@1 | Hit@3 | Hit@5 | Hit@10 | MRR@10 |
|---|---|---|---|---|---|
| Fixed 300-token, no overlap | 73% | 83% | 90% | 93% | 0.80 |
| Fixed 300-token, 50-token overlap | 70% | 93% | 93% | 97% | 0.81 |
| Recursive split (production) | 67% | 83% | 83% | 93% | 0.76 |
| Recursive split + Gemini re-rank | 67% | 90% | 93% | 97% | 0.78 |

Re-ranker row is genuinely reranked (27/30 questions actually got a Gemini
reordering, not a vector-order fallback) after switching the reranker to
`gemini-flash-lite-latest` (see Workstream 4) — a real, modest lift over
plain recursive (Hit@3 83%→90%, Hit@5 83%→93%).

Semantic chunking row is still blocked, not broken: `gemini-embedding-001`
hit its free-tier **daily** request quota again on the next day's re-run,
meaning Google's reset boundary doesn't align with local midnight and
hasn't rolled over yet as of this run. Re-run `npm run eval` later to fill
in the last row — the disk cache means the 3 completed strategies + the
reranker cost zero new API calls on the next run, only semantic needs to
succeed.

**Interesting honest finding, not the hoped-for one:** production's own
`recursive` splitter scores *lower* than the naive fixed-window baselines on
this dataset so far. Worth digging into in the README once semantic/rerank
fill in the full picture — don't paper over it.

### 3a. Dataset — `server/eval/dataset.jsonl`

**Corpus:** 5 classic ML papers (arXiv, clean text extraction):

| Paper | arXiv |
|---|---|
| Attention Is All You Need | 1706.03762 |
| BERT | 1810.04805 |
| Retrieval-Augmented Generation for Knowledge-Intensive NLP | 2005.11401 |
| LoRA: Low-Rank Adaptation of LLMs | 2106.09685 |
| Dense Passage Retrieval for Open-Domain QA | 2004.04906 |

**~50 questions, ~10 per paper.** Schema:

```json
{
  "id": "q007",
  "question": "What sub-layer does the Transformer add around each attention and feed-forward block?",
  "answer": "A residual connection followed by layer normalization.",
  "doc": "attention-is-all-you-need",
  "gold_quote": "We employ a residual connection around each of the two sub-layers, followed by layer normalization.",
  "page": 3,
  "type": "factual"
}
```

**Type mix:** ~50% `factual`, ~25% `multihop` (multiple `gold_quote`s),
~25% `paraphrase` (no vocabulary overlap with the passage — where semantic
retrieval earns its number).

**Build process (state in README):** Gemini drafts 3–4 candidate Q&A per
chunk → **human-verify and edit every one**. The manual pass is what makes it
credible.

**Effort:** 4–6 hrs.

### 3b. Harness — `server/eval/`

```
server/eval/
  datasets/papers/*.txt        # extracted paper text
  dataset.jsonl                # the 50 Q&A
  adversarial.jsonl            # Workstream 4
  strategies.js                # chunking strategy implementations
  index.js                     # build in-memory vector index for a strategy
  metrics.js                   # hit@k, MRR, recall@k, (optional) judge
  rerank.js                    # Gemini listwise re-ranker
  guardrails.js                # Workstream 4
  run.js                       # CLI entrypoint
  results/
    embeddings.cache.json      # hash(text) -> vector; reruns free/offline
    <timestamp>.json           # raw run output
    summary.md                 # generated comparison table
```

**Design choices:**
- **In-memory brute-force cosine**, not Qdrant — 5 papers ≈ 1000 chunks,
  trivial to score exhaustively; keeps eval off real user data / running infra.
  `npm run eval` just works.
- **Disk-cached embeddings** keyed by text hash — embed once (on hotspot),
  iterate metrics offline forever. Sidesteps the proxy problem.
- Same embedding model as prod (`gemini-embedding-001`).

**Chunking strategies compared:**
1. `fixed-256-0` — fixed 256 tokens, no overlap
2. `fixed-256-50` — fixed 256 tokens, 50 overlap
3. `recursive-300-50` — current prod approach
4. `semantic` — embed sentence-windows, cut where consecutive-window cosine
   similarity drops below the Nth percentile
5. `recursive-300-50 + rerank` — retrieve top-20 by vector sim, Gemini reorders to top-5

**Metrics:**
- `hit@k`, k ∈ {1,3,5,10} — relevant chunk in top k? Relevant =
  token-overlap(chunk, gold_quote) ≥ 0.6, or (same doc AND page).
- `MRR@10` — mean of 1/(rank of first relevant chunk).
- `recall@k` — multi-hop: fraction of gold chunks retrieved.
- *Optional* `answer_correctness` — Gemini-as-judge (1–5), with the LLM-judge caveat noted.

**Re-ranker:** Gemini listwise (`rerank.js`) — prompt with 20 candidates, get
a reordering. No new dependency. Note in README that a real cross-encoder
(`bge-reranker`) is the "proper" choice but needs a heavy ONNX download the
network makes painful.

### 3c. README section

```markdown
## Retrieval evaluation

Across 50 human-verified questions over 5 ML papers:

| Chunking strategy            | Hit@3 | Hit@5 | MRR@10 |
|------------------------------|:-----:|:-----:|:------:|
| Fixed 256-token, no overlap  |  XX%  |  XX%  |  0.XX  |
| Fixed 256-token, 50 overlap  |  XX%  |  XX%  |  0.XX  |
| Recursive split (current)    |  XX%  |  XX%  |  0.XX  |
| Semantic chunking            |  XX%  |  XX%  |  0.XX  |
| + Gemini re-ranker           |  XX%  |  XX%  |  0.XX  |

Semantic chunking raised hit-rate@5 from XX% to XX%; the re-ranker added a
further X points. Harness + dataset in `server/eval/`, `npm run eval`.

**Caveats:** 50 questions, single domain — a smoke-test eval, not a benchmark.
Questions are LLM-drafted and human-verified, biasing toward answerable
lookups. The re-ranker adds ~Xs latency and one extra LLM call per query.
```

**Effort:** harness 6–8 hrs · semantic chunking 2–3 hrs · re-ranker 2 hrs ·
run + writeup 2–3 hrs.

---

## Workstream 4 — Guardrails  ◐

**Free parts shipped:** explicit `<source n="X" from="...">` delimiters
framing retrieved content as DATA not instructions in `chat.service.js`;
explicit Gemini `safetySettings`; regex-based query pre-screening
(`looksLikeInjectionAttempt`) rejecting jailbreak-style queries before
spending a Gemini call, with zero-cost canned response on a match.
Ingestion-time scanning, per-user rate limiting, and the adversarial eval
set (below) are still open.

**Separate production bug found and fixed along the way:** `gemini-flash-latest`
currently resolves to `gemini-3.8-flash`, whose free-tier quota is a
project-wide **20 requests/day** — confirmed by direct API probing during
eval development (the reranker's own calls tripped it). The exact same
model string was used in production `chat.service.js`, meaning the live
chat feature was likely capped at ~20 answers/day, not just occasionally
503-overloaded. Switched production (and the eval reranker) to
`gemini-flash-lite-latest` (→ `gemini-3.5-flash-lite`), which has its own,
far less constrained free-tier quota bucket — confirmed working immediately
after the flash model's daily quota was fully exhausted.

Three layers. Fold the free parts into Workstream 3; the rest is its own pass.

### Layer 1 — Ingestion: indirect prompt injection

A user uploads a PDF containing `"IGNORE ALL PREVIOUS INSTRUCTIONS..."`; it
gets chunked, retrieved, and injected as "context".

- **Structural (nearly free, always on):** wrap retrieved chunks in explicit
  delimiters in `chat.service.js`; instruct the model that text between
  `<source>` tags is DATA, never instructions.
- **Ingestion scan (~2 hrs):** on document processing, flag chunks matching
  injection patterns (`ignore (previous|all) instructions`, `you are now`,
  `system:`, `disregard the above`, AI-directed imperatives). Quarantine or
  strip, log the hit.
- *Optional:* Gemini classifier pass on suspicious chunks.

### Layer 2 — Input: query screening

- Heuristic + optional light LLM check: jailbreak / injection / off-topic-abuse
  → reject before spending a Gemini call.
- **Per-user rate limiting** — also strengthens the credit/abuse story.
- Hard max query length.

### Layer 3 — Output: groundedness + safety

- **Groundedness check** — claim-heavy answer with zero `[n]` citation markers
  → downgrade to "I'm not confident this is in your documents." Stronger:
  cheap second LLM/NLI call, "is every sentence supported by the context?"
- **Configure Gemini `safetySettings` explicitly** in `chat.service.js`.
- ~~DIY PII scrubbing on output~~ — skip; noisy, Gemini covers most.

### Eval integration (the payoff)

`server/eval/adversarial.jsonl` — 25–30 attack cases (query injections,
poisoned test doc, jailbreaks, off-topic). New metric: **attack-success rate**.

README line: *"Blocks 27/30 known prompt-injection and jailbreak attempts;
structured-context prompting stopped all 12 indirect-injection payloads
embedded in uploaded documents."*

**Effort:** free parts ~1 hr · ingestion scan + input screening + rate
limiting + adversarial set ~1.5 days.

---

## Execution order

1. ☑ Credit reset — removes the dead-end
2. ☑ Stats cleanup — removes the credibility landmine (all `/stats` numbers now real)
3. ☑ Guardrails free parts: delimiter prompting, `safetySettings`, query pre-screening
4. ☑ Eval scaffold: in-memory index + metrics + embedding cache
5. ☑ Dataset — 30 questions, 3 papers, human-verified against extracted page text
6. ☑ Run baselines → first real numbers (3/4 base strategies; see Workstream 3)
7. ☐ Semantic chunking → rerun (still blocked on daily embedding quota reset)
8. ☑ Re-ranker → real result in (27/30 genuinely reranked, after switching to `gemini-flash-lite-latest`)
9. ☐ Guardrails Workstream 4 proper + adversarial eval set (~1.5 days)
10. ☐ README tables + interpretation (once semantic/rerank fill in)

**Total ≈ 30–35 hrs.** Commit each step separately — real extension work,
helps the thin contribution graph.
