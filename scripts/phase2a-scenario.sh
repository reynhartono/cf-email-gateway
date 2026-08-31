#!/usr/bin/env bash
# Synthetic Phase 2a compose helper.
set -euo pipefail
BASE="${COMPOSE_BASE_URL:-https://cf-email-gateway.<account>.workers.dev}"
TOKEN="${COMPOSE_API_TOKEN:?set COMPOSE_API_TOKEN}"
TO="${COMPOSE_TO:-me@gmail.com}"
FROM="${COMPOSE_FROM:-me@example.com}"
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  "$BASE/v1/compose" \
  -d "{\"from\":\"$FROM\",\"to\":\"$TO\",\"subject\":\"compose smoke\",\"text\":\"hello\"}"
echo
