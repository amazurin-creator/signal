# Signal

**Live URL:** `https://signal.signal-awio.workers.dev`

A game studio LiveOps tool that turns raw player reviews into a prioritized, evidence-backed backlog. Paste reviews (or upload a CSV), hit Analyze, and get up to 6 labeled issue clusters — each with severity, sentiment, verbatim quotes, and a ready-to-paste ticket — in a single LLM call. Token cost and cache status are shown for every run.

**BYOK** — the server holds no API key. Enter your own `sk-ant-…` key in the sidebar; it stays in your browser's localStorage only.

---

## Architecture

```
Browser (Vanilla JS, no build)
    │
    │  GET /               → index.html
    │  GET /app.js         → app.js
    │  GET /styles.css     → styles.css
    │  GET /sample.json    → 80 synthetic reviews
    │  GET /sample-result.json → bundled pre-computed demo
    │
    ▼
Cloudflare Worker  (src/worker.ts)
    │
    ├─── POST /api/analyze   normalise → SHA-256 cache → 401 if no key → rate limit → Anthropic API
    ├─── GET  /api/runs       list last 50 runs
    ├─── GET  /api/runs/:id   full run with clusters
    └─── GET  /api/stats      totals across all runs
    │
    ├── Cloudflare D1 (SQLite)   runs table — history, cache, rate limits
    └── Anthropic Messages API   claude-haiku-4-5-20251001, tool_choice forced
                                 Key supplied per-request via X-Anthropic-Key header
```

---

## Run locally

```bash
# 1. Install deps
npm install

# 2. Create local D1 database (SQLite in .wrangler/)
npm run db:migrate:local

# 3. Start the dev server (no API key needed for the server itself)
npm run dev
# → http://localhost:8787
# Enter your Anthropic key in the UI sidebar to run live analyses
```

---

## Deploy to Cloudflare Workers

```bash
# 1. Login (one-time)
npx wrangler login

# 2. Create D1 database — copy the database_id from the output
npx wrangler d1 create signal-db
# Paste the database_id into wrangler.toml

# 3. Apply migration to production
npm run db:migrate:remote

# 4. Deploy (no secrets needed — BYOK)
npm run deploy
# → https://signal.<subdomain>.workers.dev
```

---

## Smoke test

```bash
chmod +x scripts/smoke.sh

# Without API key: tests 401 behavior and static assets
./scripts/smoke.sh https://signal.<subdomain>.workers.dev

# With API key: full test including live analysis and cache-hit verification
./scripts/smoke.sh https://signal.<subdomain>.workers.dev sk-ant-...
# or: ANTHROPIC_API_KEY=sk-ant-... ./scripts/smoke.sh <url>
```

---

## Token-economy decisions

| Decision | Why |
|---|---|
| **BYOK** | Server holds no key. Each request sends the key in `X-Anthropic-Key`; Worker uses it once, never stores or logs it. |
| **Cache-before-key-check** | SHA-256 cache is consulted before the key is read. Cache hits are always free and require no key. |
| **One LLM call per batch** | Reviews are concatenated into a single prompt. No per-review calls ever. |
| **Normalize before prompting** | Trim + dedup + truncate to 400 chars + cap at 200 reviews. Directly shrinks the prompt. |
| **`tool_choice` forced** | No free-form prose in the response — only the JSON tool payload. Zero wasted output tokens. |
| **Quote validation in code** | Verbatim-substring check in the Worker. Hallucinated quotes are dropped without a retry call. |
| **Demo mode** | `sample-result.json` is a bundled pre-computed result. Reviewers see clusters instantly with no key. |

---

## Related files

- [`PROMPT.md`](./PROMPT.md) — original product spec / test-task brief
- [`TOKEN_LOG.md`](./TOKEN_LOG.md) — development token usage log
