#!/usr/bin/env bash
# Refresh the live data on the GX10 from this Mac. The service rebuilds with the lake on restart (node is on the GX10);
# the Mac-side build + copy below is kept as a fallback for a server without node:
#   1. pull the scraper's finished output (data-lake/gold: lens/menus.json, dishes.json, page images)
#   2. node tools/build-data.js --with-lake  -> data/menus.lens.json (seed + lake, knowledge base joined)
#   3. copy that file to the serve clone on the GX10 and restart the server (pid file)
#   4. rebuild without the lake so the committed Assets/Data/AllergyData.ts is untouched
# Usage: bash tools/server/sync_lake.sh [user@host]      (default mukesh@gx10-733b.local)
set -euo pipefail
HOST="${1:-mukesh@gx10-733b.local}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=8"
cd "$REPO"
mkdir -p data-lake/gold/lens
scp -q -o BatchMode=yes "$HOST:AllergyLens/data-lake/gold/lens/menus.json" data-lake/gold/lens/menus.json
scp -q -o BatchMode=yes "$HOST:AllergyLens/data-lake/gold/dishes.json" data-lake/gold/dishes.json
rsync -az -e "$SSH" --include='*/' --include='menu-*.*' --exclude='*' "$HOST:AllergyLens/data-lake/gold/lens/menus/" data-lake/gold/lens/menus/
node tools/build-data.js --with-lake
scp -q -o BatchMode=yes data/menus.lens.json "$HOST:allergylens-serve/data/menus.lens.json"
node tools/build-data.js >/dev/null            # restore the committed snapshot (no lake)
# With node on the GX10 the systemd service rebuilds with the lake on every restart, so a restart is enough.
$SSH "$HOST" 'cd ~/allergylens-serve && git pull -q origin main 2>/dev/null || true
  sudo -n systemctl restart allergylens-data && sleep 3 && curl -fsS -m 3 http://localhost:8787/health; echo'
IP=$($SSH "$HOST" "hostname -I | awk '{print \$1}'")
TUN=$(bash "$REPO/tools/server/tunnel_url.sh" "$HOST" 2>/dev/null || true)
echo "live (LAN):   http://$IP:8787/menus.json"
echo "live (https): ${TUN:-<tunnel not running>}/menus.json   <- this goes into menusUrl"
node tools/check.js --profile milk --url "${TUN:-http://$IP:8787}/menus.json" | head -3
