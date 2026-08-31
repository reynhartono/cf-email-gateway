#!/usr/bin/env bash
# Synthetic Phase 1 checklist helper (no personal domains).
set -euo pipefail
ts=$(date +%s)
echo "Send test mail to unique locals on your Worker catch-all domain, e.g.:"
echo "  p1-b1-${ts}@example.com"
echo "Expect: D1 completed, cf_forward to me@gmail.com (or your default_inbox), R2 if archive on."
echo "Use test/scenarios/batch*.yaml as ROUTING_YAML templates."
