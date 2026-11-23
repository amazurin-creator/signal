import type { D1Database, Fetcher, ExecutionContext } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // No server-side API key — users supply their own via X-Anthropic-Key header (BYOK)
}

// --- Constants ---
const MODEL = "claude-haiku-4-5-20251001";
const INPUT_COST_PER_M = 1.0;   // USD per 1M input tokens
const OUTPUT_COST_PER_M = 5.0;  // USD per 1M output tokens
const MAX_REVIEWS = 200;
const MAX_REVIEW_CHARS = 400;
const MAX_CLUSTERS = 6;
const MAX_RUNS_PER_IP_PER_DAY = 10;

// --- Tool schema for structured output ---
const CLUSTER_TOOL = {
  name: "report_clusters",
  description:
    "Report discovered clusters of issues or themes from player reviews. Quotes must be verbatim substrings of the input reviews.",
  input_schema: {
    type: "object",
    properties: {
      clusters: {
        type: "array",
        maxItems: MAX_CLUSTERS,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short descriptive title for this cluster" },
            type: {
              type: "string",
              enum: ["bug", "balance", "monetization", "feature_request", "praise"],
            },
            severity: {
              type: "integer",
              minimum: 1,
              maximum: 5,
              description: "1=trivial, 5=critical",
            },
            share: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Estimated fraction of reviews mentioning this topic",
            },
            sentiment: { type: "string", enum: ["negative", "mixed", "positive"] },
            quotes: {
              type: "array",
              minItems: 2,
              maxItems: 3,
              items: { type: "string", description: "Verbatim text from one of the input reviews" },
            },
            ticket: {
              type: "object",
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                acceptance_criteria: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 2,
                },
              },
              required: ["title", "description", "acceptance_criteria"],
            },
          },
          required: ["title", "type", "severity", "share", "sentiment", "quotes", "ticket"],
        },
      },
    },
    required: ["clusters"],
  },
};

// --- Utility functions ---

function normalizeReviews(raw: string[]): { normalized: string[]; dropped: number } {
  const seen = new Set<string>();
  const normalized: string[] = [];
  let dropped = 0;

  for (const r of raw) {
    const trimmed = r.trim();
    if (!trimmed) {
      dropped++;
      continue;
    }
    const truncated = trimmed.slice(0, MAX_REVIEW_CHARS);
    if (seen.has(truncated)) {
      dropped++;
      continue;
    }
    seen.add(truncated);
    if (normalized.length < MAX_REVIEWS) {
      normalized.push(truncated);
    } else {
      dropped++;
    }
  }

  return { normalized, dropped };
}

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function calcCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens * INPUT_COST_PER_M + outputTokens * OUTPUT_COST_PER_M) / 1_000_000;
}

function validateQuotes(clusters: any[], normalized: string[]): any[] {
  const allText = normalized.join("\n");
  return clusters.map((cluster) => ({
    ...cluster,
    quotes: (cluster.quotes || []).filter(
      (q: unknown) => typeof q === "string" && q.length > 0 && allText.includes(q)
    ),
  }));
}

async function checkRateLimit(db: D1Database, ip: string): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const result = await db
    .prepare(
      `SELECT COUNT(*) as count FROM runs WHERE ip = ? AND substr(created_at, 1, 10) = ? AND cache_hit = 0`
    )
    .bind(ip, today)
    .first<{ count: number }>();
  return (result?.count ?? 0) < MAX_RUNS_PER_IP_PER_DAY;
}

// --- Anthropic API call ---

async function analyzeReviews(
  apiKey: string,
  reviews: string[]
): Promise<{ clusters: any[]; inputTokens: number; outputTokens: number; latencyMs: number }> {
  const systemPrompt = `You are a mobile game analyst. Identify up to ${MAX_CLUSTERS} distinct clusters of issues or themes in the player reviews. Quotes MUST be verbatim substrings copied exactly from the input.`;
  const userPrompt = `Analyze these ${reviews.length} player reviews:\n\n${reviews.join("\n")}`;

  const start = Date.now();

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: [CLUSTER_TOOL],
      tool_choice: { type: "tool", name: "report_clusters" },
    }),
  });

  const latencyMs = Date.now() - start;

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as any;
  const usage = data.usage;
  const toolUse = data.content?.find(
    (c: any) => c.type === "tool_use" && c.name === "report_clusters"
  );

  if (!toolUse) throw new Error("Model did not return structured clusters");

  const clusters = Array.isArray(toolUse.input?.clusters) ? toolUse.input.clusters : [];

  return {
    clusters,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    latencyMs,
  };
}

// --- Response helpers ---

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Anthropic-Key",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// --- Route handlers ---

async function handleAnalyze(request: Request, env: Env): Promise<Response> {
  let body: { reviews: unknown };
  try {
    body = (await request.json()) as { reviews: unknown };
  } catch {
    return err("Invalid JSON body");
  }

  if (!Array.isArray(body.reviews) || body.reviews.length === 0) {
    return err("reviews must be a non-empty array");
  }

  const rawReviews = (body.reviews as unknown[]).map((r) => String(r));
  const rawCount = rawReviews.length;
  const { normalized, dropped } = normalizeReviews(rawReviews);

  if (normalized.length === 0) {
    return err("No valid reviews after normalization");
  }

  // Cache lookup
  const inputHash = await sha256(normalized.join("\n"));
  const cached = await env.DB.prepare(`SELECT * FROM runs WHERE input_hash = ? LIMIT 1`)
    .bind(inputHash)
    .first<Record<string, unknown>>();

  if (cached) {
    const { result_json, ip: _ip, cache_hit: _ch, dropped_count: _dc, ...rest } = cached as any;
    return json({ ...rest, cache_hit: true, dropped_count: dropped, result: JSON.parse(result_json) });
  }

  // Key check — after cache so cached runs work without a key
  const apiKey = request.headers.get("X-Anthropic-Key")?.trim();
  if (!apiKey) {
    return err(
      "API key required. Enter your Anthropic API key in the sidebar to run a live analysis. Cached results are always free.",
      401
    );
  }

  // Rate limit
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "0.0.0.0";

  const withinLimit = await checkRateLimit(env.DB, ip);
  if (!withinLimit) {
    return err(
      `Rate limit exceeded: max ${MAX_RUNS_PER_IP_PER_DAY} analyses per IP per day. Try again tomorrow.`,
      429
    );
  }

  // LLM call
  const { clusters: rawClusters, inputTokens, outputTokens, latencyMs } = await analyzeReviews(
    apiKey,
    normalized
  );

  // Validate quotes
  const clusters = validateQuotes(rawClusters, normalized);
  const cost = calcCost(inputTokens, outputTokens);

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const resultJson = JSON.stringify({ clusters });

  await env.DB.prepare(
    `INSERT INTO runs (id, created_at, input_hash, review_count, dropped_count, cluster_count, model, input_tokens, output_tokens, cost_usd, latency_ms, cache_hit, ip, result_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  )
    .bind(
      id, createdAt, inputHash,
      normalized.length, rawCount - normalized.length,
      clusters.length, MODEL,
      inputTokens, outputTokens, cost,
      latencyMs, ip, resultJson
    )
    .run();

  return json(
    {
      id, created_at: createdAt, input_hash: inputHash,
      review_count: normalized.length,
      dropped_count: rawCount - normalized.length,
      cluster_count: clusters.length,
      model: MODEL,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
      latency_ms: latencyMs,
      cache_hit: false,
      result: { clusters },
    },
    201
  );
}

async function handleListRuns(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, review_count, dropped_count, cluster_count, model,
            input_tokens, output_tokens, cost_usd, latency_ms, cache_hit
     FROM runs ORDER BY created_at DESC LIMIT 50`
  ).all<Record<string, unknown>>();

  return json(results.map((r) => ({ ...r, cache_hit: r.cache_hit === 1 })));
}

async function handleGetRun(env: Env, id: string): Promise<Response> {
  const run = await env.DB.prepare(`SELECT * FROM runs WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();

  if (!run) return err("Run not found", 404);

  const { result_json, ip: _ip, ...rest } = run as any;
  return json({ ...rest, cache_hit: rest.cache_hit === 1, result: JSON.parse(result_json) });
}

async function handleStats(env: Env): Promise<Response> {
  const stats = await env.DB.prepare(
    `SELECT
       COUNT(*) as total_runs,
       COALESCE(SUM(input_tokens), 0) as total_input_tokens,
       COALESCE(SUM(output_tokens), 0) as total_output_tokens,
       COALESCE(SUM(cost_usd), 0) as total_cost_usd,
       COALESCE(SUM(cache_hit), 0) as cache_hits
     FROM runs`
  ).first<Record<string, unknown>>();

  return json(stats);
}

// --- Main fetch handler ---

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (pathname.startsWith("/api/")) {
      try {
        if (pathname === "/api/analyze" && request.method === "POST")
          return handleAnalyze(request, env);
        if (pathname === "/api/runs" && request.method === "GET")
          return handleListRuns(env);
        if (pathname.startsWith("/api/runs/") && request.method === "GET")
          return handleGetRun(env, pathname.slice("/api/runs/".length));
        if (pathname === "/api/stats" && request.method === "GET")
          return handleStats(env);
        return err("Not found", 404);
      } catch (e: any) {
        console.error("API error:", e);
        return err(e?.message ?? "Internal server error", 500);
      }
    }

    // Static assets — Cloudflare ASSETS binding serves public/ files
    // Map "/" → "/index.html" explicitly
    const assetRequest =
      pathname === "/"
        ? new Request(new URL("/index.html", url), request)
        : request;

    return env.ASSETS.fetch(assetRequest);
  },
};
