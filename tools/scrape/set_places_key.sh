#!/usr/bin/env bash
# Store the Google Places API key in <repo>/.env (gitignored) without it showing on screen or in shell history.
# Usage: tools/scrape/set_places_key.sh     then paste the key at the hidden prompt and press Enter.
set -euo pipefail
cd "$(dirname "$0")/../.."
read -r -s -p "Paste the Google Places API key, then press Enter (nothing is echoed): " KEY
echo
KEY=$(printf '%s' "$KEY" | tr -d '[:space:]"'"'")
if [ ${#KEY} -lt 20 ]; then echo "That is too short to be a key (${#KEY} chars). Nothing written."; exit 1; fi
touch .env; chmod 600 .env
grep -v '^GOOGLE_PLACES_API_KEY=' .env > .env.tmp || true
printf 'GOOGLE_PLACES_API_KEY=%s\n' "$KEY" >> .env.tmp
mv .env.tmp .env
unset KEY
echo "Saved to $(pwd)/.env ($(grep -c . .env) line(s)). The driver reads it at the next county."
