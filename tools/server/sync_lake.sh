#!/usr/bin/env bash
# Refresh the live data on the GX10 from this Mac (the GX10 has no node, so the join runs here):
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
$SSH "$HOST" 'mkdir -p ~/logs; if [ -f ~/logs/allergylens-data.pid ]; then kill "$(cat ~/logs/allergylens-data.pid)" 2>/dev/null || true; sleep 1; fi
  cd ~/allergylens-serve && git pull -q origin main 2>/dev/null || true
  (setsid nohup python3 -u tools/serve_data.py --host 0.0.0.0 --port 8787 >> ~/logs/allergylens-data.log 2>&1 < /dev/null & echo $! > ~/logs/allergylens-data.pid)
  sleep 2; curl -fsS -m 3 http://localhost:8787/health; echo'
IP=$($SSH "$HOST" "hostname -I | awk '{print \$1}'")
echo "live: http://$IP:8787/menus.json"
node tools/check.js --profile milk --url "http://$IP:8787/menus.json" | head -3
