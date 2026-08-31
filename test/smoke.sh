#!/usr/bin/env bash
set -euo pipefail
out="$(pi --no-extensions -e "$(pwd)/src/index.ts" --model openai-codex/gpt-5.6-luna:medium --tools swarm --no-session -p 'Call swarm once with description smoke, one task item ping with prompt Reply exactly WORKER_OK, concurrency 1. Return only its worker output.')"
grep -q 'WORKER_OK' <<<"$out"
printf 'swarm smoke PASS\n'
