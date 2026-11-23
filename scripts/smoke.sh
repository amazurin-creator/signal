#!/usr/bin/env bash
# Signal smoke test — BYOK edition
# Usage:  ./scripts/smoke.sh <base-url> [anthropic-api-key]
#         If api-key is omitted, ANTHROPIC_API_KEY env var is checked.
#         Without a key, only the 401 and static-asset tests run.

set -euo pipefail

BASE="${1:?Usage: $0 <base-url> [anthropic-api-key]}"
BASE="${BASE%/}"
API_KEY="${2:-${ANTHROPIC_API_KEY:-}}"

PASS=0
FAIL=0

check() {
  local name="$1"
  local condition="$2"
  if eval "$condition" 2>/dev/null; then
    echo "✓ $name"
    ((PASS++)) || true
  else
    echo "✗ $name"
    ((FAIL++)) || true
  fi
}

echo "=== Signal smoke tests → $BASE ==="
[ -z "$API_KEY" ] && echo "  (no API key — live-analysis tests will be skipped)"
echo ""

# ---- 401 without key on fresh input ----
echo "→ POST /api/analyze without key (must be 401)"
UNIQUE="Unique smoke-test review $(date +%s%N) — please ignore"
NO_KEY_RESP=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d "{\"reviews\":[\"$UNIQUE\"]}" \
  "$BASE/api/analyze")
NO_KEY_HTTP=$(echo "$NO_KEY_RESP" | tail -1)
check "Returns 401 without key on non-cached input" '[ "$NO_KEY_HTTP" = "401" ]'

echo ""

# ---- Live analysis (requires key) ----
RUN_ID=""
if [ -n "$API_KEY" ]; then
  echo "→ POST /api/analyze with key (live run)"
  REVIEWS='["Game crashes after level 12. Completely unplayable!","Energy timer is 30 mins per life. Way too long.","Love the graphics, very addictive.","An ad after every single level. Uninstalled.","Please add guild mode so I can play with friends."]'
  ANALYZE_BODY="{\"reviews\":$REVIEWS}"

  ANALYZE_RESP=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "X-Anthropic-Key: $API_KEY" \
    -d "$ANALYZE_BODY" \
    "$BASE/api/analyze")

  ANALYZE_HTTP=$(echo "$ANALYZE_RESP" | tail -1)
  ANALYZE_JSON=$(echo "$ANALYZE_RESP" | sed '$d')

  check "POST /api/analyze returns 200 or 201" \
    '[ "$ANALYZE_HTTP" = "200" ] || [ "$ANALYZE_HTTP" = "201" ]'

  RUN_ID=$(echo "$ANALYZE_JSON" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  check "Response contains run id" '[ -n "$RUN_ID" ]'

  HAS_CLUSTERS=$(echo "$ANALYZE_JSON" | grep -c '"clusters"' || true)
  check "Response contains clusters" '[ "$HAS_CLUSTERS" -gt 0 ]'

  HAS_TOKENS=$(echo "$ANALYZE_JSON" | grep -c '"input_tokens"' || true)
  check "Response contains token usage" '[ "$HAS_TOKENS" -gt 0 ]'

  echo ""

  # ---- Cache hit (same input, no key required) ----
  echo "→ POST /api/analyze same input (cache hit — no key)"
  CACHE_RESP=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d "$ANALYZE_BODY" \
    "$BASE/api/analyze")

  CACHE_HTTP=$(echo "$CACHE_RESP" | tail -1)
  CACHE_JSON=$(echo "$CACHE_RESP" | sed '$d')

  check "Cache hit returns 200" '[ "$CACHE_HTTP" = "200" ] || [ "$CACHE_HTTP" = "201" ]'

  CACHE_HIT=$(echo "$CACHE_JSON" | grep -c '"cache_hit":true' || true)
  check "cache_hit is true" '[ "$CACHE_HIT" -gt 0 ]'

  ZERO_INPUT=$(echo "$CACHE_JSON" | grep -o '"input_tokens":[0-9]*' | grep -c ':0' || true)
  check "Cache hit has 0 input tokens" '[ "$ZERO_INPUT" -gt 0 ]'

  echo ""
else
  echo "→ Skipping live analysis and cache-hit tests (no API key)"
  echo ""
fi

# ---- GET /api/runs ----
echo "→ GET /api/runs"
RUNS_RESP=$(curl -s -w "\n%{http_code}" "$BASE/api/runs")
RUNS_HTTP=$(echo "$RUNS_RESP" | tail -1)
RUNS_JSON=$(echo "$RUNS_RESP" | sed '$d')

check "GET /api/runs returns 200" '[ "$RUNS_HTTP" = "200" ]'
check "Returns JSON array" '[ "$(echo "$RUNS_JSON" | head -c1)" = "[" ]'

echo ""

# ---- GET /api/runs/:id ----
echo "→ GET /api/runs/:id"
if [ -n "$RUN_ID" ]; then
  RUN_RESP=$(curl -s -w "\n%{http_code}" "$BASE/api/runs/$RUN_ID")
  RUN_HTTP=$(echo "$RUN_RESP" | tail -1)
  RUN_JSON=$(echo "$RUN_RESP" | sed '$d')
  check "GET /api/runs/:id returns 200" '[ "$RUN_HTTP" = "200" ]'
  HAS_RESULT=$(echo "$RUN_JSON" | grep -c '"result"' || true)
  check "Full run contains result field" '[ "$HAS_RESULT" -gt 0 ]'
else
  echo "  (skipped — no run id; re-run with an API key to test this endpoint)"
fi

echo ""

# ---- GET /api/stats ----
echo "→ GET /api/stats"
STATS_RESP=$(curl -s -w "\n%{http_code}" "$BASE/api/stats")
STATS_HTTP=$(echo "$STATS_RESP" | tail -1)
STATS_JSON=$(echo "$STATS_RESP" | sed '$d')

check "GET /api/stats returns 200" '[ "$STATS_HTTP" = "200" ]'
check "Stats contains total_runs"    '[ "$(echo "$STATS_JSON" | grep -c "total_runs")" -gt 0 ]'
check "Stats contains total_cost_usd" '[ "$(echo "$STATS_JSON" | grep -c "total_cost_usd")" -gt 0 ]'

echo ""

# ---- Static assets ----
echo "→ Static assets"
INDEX_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/")
check "GET / returns 200" '[ "$INDEX_HTTP" = "200" ]'

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
