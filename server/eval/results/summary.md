# Retrieval evaluation results

Generated 2026-09-12T20:07:22.073Z
Questions: 30 across 3 documents (attention-is-all-you-need, bert, rag)

| Chunking strategy | Hit@1 | Hit@3 | Hit@5 | Hit@10 | MRR@10 |
|---|---|---|---|---|---|
| Fixed 300-token, no overlap | 73% | 83% | 90% | 93% | 0.80 |
| Fixed 300-token, 50-token overlap | 70% | 93% | 93% | 97% | 0.81 |
| Recursive split (production) | 67% | 83% | 83% | 93% | 0.76 |
| Recursive split + Gemini re-rank | 67% | 90% | 93% | 97% | 0.78 |

_Semantic chunking row omitted this run: Embedding batch failed after 8 attempts: [GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents: [429 Too Many Requests] You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  - re-run later once the daily quota resets._
