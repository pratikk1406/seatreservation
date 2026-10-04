#!/usr/bin/env bash
set -e

BASE_URL="${1:-http://localhost:3000}"
echo "Triggering on-sale burst test against: ${BASE_URL}"

# If node is available, run scripts/burst.js
if command -v node >/dev/null 2>&1; then
  node scripts/burst.js "${BASE_URL}"
else
  echo "Error: node is required to run the burst test."
  exit 1
fi
