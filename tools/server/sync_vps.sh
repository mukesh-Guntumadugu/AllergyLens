#!/usr/bin/env bash
# Copy the GX10's gold catalog to the VPS and restart the API there. Run from the Mac:
#     bash tools/server/sync_vps.sh [gx10-host] [vps-host]
# Only gold/ moves (the joined menus, the dish catalog, products): a few MB, never the 33 GB bronze store.
set -euo pipefail
GX10="${1:-mukesh@gx10-733b.local}"
VPS="${2:-root@72.62.33.46}"
VPS_REPO="${VPS_REPO:-/root/allergylens}"
TMP="$(mktemp -d)"
rsync -az --delete -e "ssh -o BatchMode=yes" "$GX10:AllergyLens/data-lake/gold/" "$TMP/gold/"
rsync -az --delete -e "ssh -o BatchMode=yes" "$TMP/gold/" "$VPS:$VPS_REPO/data-lake/gold/"
rm -rf "$TMP"
ssh -o BatchMode=yes "$VPS" "cd $VPS_REPO && git pull -q && systemctl restart allergylens-api && sleep 3 && curl -fsS http://127.0.0.1:8787/health && echo"
