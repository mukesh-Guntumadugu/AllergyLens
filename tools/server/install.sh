#!/usr/bin/env bash
# One-time install of the AllergyLens data server on the GX10 (Ubuntu). Run from the repo root:
#     bash tools/server/install.sh
# Afterwards:  systemctl status allergylens-data ; journalctl -u allergylens-data -f
#              curl http://localhost:8787/health
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
USER_NAME="${SUDO_USER:-$(whoami)}"
command -v node >/dev/null || { echo "node is required (tools/build-data.js)"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }
node "$REPO/tools/build-data.js"
sed -e "s|__USER__|$USER_NAME|" -e "s|__REPO__|$REPO|" "$REPO/tools/server/allergylens-data.service" | sudo tee /etc/systemd/system/allergylens-data.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now allergylens-data
sleep 1
curl -fsS http://localhost:8787/health && echo
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "Lens Studio: set menusUrl on the AllergyLens object to http://${IP:-<this-ip>}:8787/menus.json"
echo "From another machine: node tools/check.js --profile milk --url http://${IP:-<this-ip>}:8787/menus.json"
