# Token log

All development was done with **Claude Code** in one headless session (`claude -p`), started from [`PROMPT.md`](PROMPT.md) verbatim and resumed once for iteration 2. Numbers below are copied from the `usage` / `total_cost_usd` fields that Claude Code itself reports at the end of each run. Raw reports: [`logs/`](logs/).

Session id: `6ad1fd18-8e6f-4581-8ee1-e0d097ebfccf` · model `claude-sonnet-4-6`

| Run | What | Turns | Time | Input | Cache write | Cache read | Output | Cost (API-equivalent) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | Initial prompt → full app, local `wrangler dev` check | 38 | 15.4 min | 41 | 79,135 | 1,841,501 | 55,144 | $1.68 |
| 2 | BYOK + pre-computed demo + deploy + smoke tests | 55 | 16.0 min | 57 | 137,277 | 6,075,382 | 43,382 | $2.99 |
| **Total** | | **93** | **31.4 min** | **98** | **216,412** | **7,916,883** | **98,526** | **$4.67** |

Planning (choosing the idea and writing `PROMPT.md`) happened in a separate interactive Claude Code session with Opus and is not included in the table above.

## How tokens were saved

- One detailed initial prompt with fixed stack, API, data model and a "done when" checklist, so the agent did not need clarifying rounds.
- Clean headless session: no MCP servers (`--strict-mcp-config`), a restricted tool list, cheaper model (Sonnet) for implementation.
- Agent rules in the prompt: no explanations, write every file once, do not re-read what was just written, no test framework.
- Almost all input was served from prompt cache (cache read is billed at 10% of normal input).
- No-build stack (Worker + vanilla JS) keeps the amount of generated code small.

## Product runtime (not development)

The app makes **one** Claude Haiku 4.5 call per analysis for the whole batch of reviews and stores real `usage` per run in D1. Identical inputs are served from cache with 0 tokens. Live totals: `GET /api/stats`.
