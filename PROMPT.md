# Initial prompt

Build **Signal**: a client-server web app that turns raw player reviews of a mobile game into a prioritized, evidence-backed backlog using an LLM. It is a test-task prototype for an AI Developer role at a game studio, so the reviewer must be able to open one URL and see it working in 30 seconds.

## User flow
1. User pastes reviews (one per line) or uploads a CSV (`text` column, optional `rating`, `date`), or clicks **"Load sample"**.
2. Server runs the analysis and stores the run.
3. UI shows: clusters of issues/requests, each with title, type (bug / balance / monetization / feature request / praise), severity 1–5, share of reviews, sentiment, 2–3 verbatim player quotes, and a ready ticket (title + description + acceptance criteria) with a "Copy as Markdown" button.
4. Every run shows a **token meter**: model, input tokens, output tokens, cost in USD, latency, cache hit yes/no. A header shows totals across all runs.
5. A history list of previous runs; any run can be reopened.

## Stack (fixed, do not change)
- Cloudflare Worker (TypeScript, no framework) serving both the API and static files from `public/`.
- Cloudflare D1 for storage, schema in `migrations/`.
- Frontend: one `index.html` + `styles.css` + `app.js`, vanilla JS, no build step, no npm UI libs.
- LLM: Anthropic Messages API via `fetch`, model `claude-haiku-4-5-20251001`. Key only in the `ANTHROPIC_API_KEY` Worker secret, never in code or git. Keep prices in one constant (`$1` input / `$5` output per 1M tokens).

## AI pipeline (token economy is a core requirement)
- **One** LLM call per run for the whole batch, never one call per review.
- Normalize input first in code: trim, drop empty and duplicate reviews, cut each review to 400 chars, cap at 200 reviews. Show "N reviews analyzed, M dropped".
- Force structured output with a single tool call (`tool_choice`), using a strict JSON schema for clusters. No free-form text.
- Short system prompt, max 6 clusters, quotes must be verbatim substrings of the input (validate in code, drop non-matching quotes).
- Cache: SHA-256 of normalized input → if a run with the same hash exists, return it with `cache_hit: true` and zero new tokens.
- Read real `usage` from the API response for the meter; do not estimate.
- Abuse guard: max 10 non-cached runs per IP per day (D1 counter), clear error message when exceeded.

## API
- `POST /api/analyze` `{ reviews: string[] }` → run
- `GET /api/runs` → list (id, created_at, review_count, cluster_count, tokens, cost, cache_hit)
- `GET /api/runs/:id` → full run
- `GET /api/stats` → total runs, total tokens, total cost, cache hits

## Sample data
`public/sample.json`: 80 realistic synthetic reviews for a fictional match-3 game "Candy Kingdoms": a crash after level 12, energy timer complaints, an overpriced starter pack, an ads-after-every-level rant, requests for a guild/PvP mode, some praise, mixed languages (mostly EN, a few RU), varied ratings. Seeded so that clusters are obvious.

## UI
Dark "LiveOps console" aesthetic: deep navy background, one neon accent, monospace for numbers, severity as colored bars, subtle grid. It must look designed, not like a default template. Works at 375px width. Add a collapsible **"How it works"** panel explaining the pipeline and the token-saving decisions in 5–6 bullets.

## Deliverables
- Deployed to `*.workers.dev` with D1 migrations applied.
- `README.md`: live URL, what it is (2 lines), architecture diagram in text, how to run locally (`wrangler dev`), how to deploy, token-economy decisions, and a link to `PROMPT.md` and `TOKEN_LOG.md`.
- `scripts/smoke.sh`: curl checks for all 4 endpoints against a given base URL.

## How to work (save tokens)
- Do not explain plans or code back to me; just build. Report only blockers and the final summary.
- Do not re-read files you just wrote. Write each file once, completely.
- No tests framework; the smoke script is enough.
- Ask me only for things you truly cannot do: the Cloudflare login and setting the API key secret.

**Done when:** the live URL loads, "Load sample" produces clusters with quotes and a token meter, the second "Load sample" is a cache hit with 0 tokens, and `scripts/smoke.sh <url>` passes.
