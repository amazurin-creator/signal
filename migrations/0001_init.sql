CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  review_count INTEGER NOT NULL,
  dropped_count INTEGER NOT NULL DEFAULT 0,
  cluster_count INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  result_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_input_hash ON runs(input_hash);
CREATE INDEX IF NOT EXISTS idx_runs_ip_date ON runs(ip, created_at);
