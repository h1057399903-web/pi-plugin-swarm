#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$root"
tarball="$(npm pack --silent --pack-destination "$tmp")"
mkdir "$tmp/app"
cd "$tmp/app"
npm init -y >/dev/null
npm install --ignore-scripts "$tmp/$tarball" >/dev/null
ext="$tmp/app/node_modules/pi-plugin-swarm/src/index.ts"
out="$(printf '%s\n' '{"id":"state","type":"get_state"}' '{"id":"stop","type":"abort"}' | pi --no-extensions -e "$ext" --no-session --mode rpc 2>/dev/null | head -20)"
grep -q '"id":"state"' <<<"$out"
printf 'SWARM_PACKED_SMOKE_OK\n'
