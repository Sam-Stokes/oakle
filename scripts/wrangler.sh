#!/bin/sh
# Runs wrangler with wrangler.local.toml when it exists (your real D1 id, never committed), else wrangler.toml.
cd "$(dirname "$0")/.."
CFG=wrangler.toml
[ -f wrangler.local.toml ] && CFG=wrangler.local.toml
exec npx wrangler "$@" --config "$CFG"
