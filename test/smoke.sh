#!/usr/bin/env bash
set -euo pipefail
# Offline smoke: registration exercises the extension without starting a model.
node --experimental-transform-types test/registration.test.mjs >/dev/null
printf 'swarm offline smoke PASS\n'
