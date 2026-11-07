#!/usr/bin/env bash
# One-time install of the AllergyLens public API on a VPS (Ubuntu 22.04/24.04, e.g. Hostinger).
# Run as a user with sudo, from a clone of the repo:
#     git clone https://github.com/mukesh-Guntumadugu/AllergyLens.git ~/allergylens && cd ~/allergylens
#     bash tools/server/install_vps.sh [--domain api.example.com]
# What it does: node + python venv with the research packages, systemd service `allergylens-api` on
# 127.0.0.1:8787, and (with --domain) Caddy as the https front door with an automatic certificate, so the
# Lens gets a stable https address: https://<domain>/menus.json and https://<domain>/lookup?dish=…
# Afterwards:  systemctl status allergylens-api ; journalctl -u allergylens-api -f
# Data: this box has no scraper lake; copy the GX10's gold catalog with
#     rsync -a mukesh@gx10:~/AllergyLens/data-lake/gold/ ~/allergylens/data-lake/gold/
# and `sudo systemctl restart allergylens-api` whenever it changes. Researched dishes land in data/lookup-cache.json.
set -euo pipefail
DOMAIN=""
while [ $# -gt 0 ]; do case "$1" in --domain) DOMAIN="$2"; shift 2;; *) echo "unknown arg $1"; exit 1;; esac; done
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
USER_NAME="${SUDO_USER:-$(whoami)}"
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
fi
command -v python3 >/dev/null || sudo apt-get install -y python3 python3-venv
python3 -c "import venv" 2>/dev/null || sudo apt-get install -y python3-venv
[ -d "$REPO/.venv" ] || python3 -m venv "$REPO/.venv"
"$REPO/.venv/bin/pip" install -q -r "$REPO/tools/server/requirements.txt"
mkdir -p "$REPO/data-lake/gold" "$REPO/data-lake/bronze"
node "$REPO/tools/build-data.js"
sed -e "s|__USER__|$USER_NAME|g" -e "s|__REPO__|$REPO|g" "$REPO/tools/server/allergylens-api.service" | sudo tee /etc/systemd/system/allergylens-api.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now allergylens-api
sleep 2
curl -fsS http://127.0.0.1:8787/health && echo
if [ -n "$DOMAIN" ]; then
  if ! command -v caddy >/dev/null; then
    sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    sudo apt-get update && sudo apt-get install -y caddy
  fi
  printf '%s {\n\treverse_proxy 127.0.0.1:8787\n}\n' "$DOMAIN" | sudo tee /etc/caddy/Caddyfile >/dev/null
  sudo systemctl reload caddy || sudo systemctl restart caddy
  echo "Lens Studio: set menusUrl on the AllergyLens object to https://$DOMAIN/menus.json"
  echo "Test: node tools/check.js --dish \"chicken tikka masala\" --profile milk --url https://$DOMAIN/menus.json"
else
  echo "No --domain given: the API listens on 127.0.0.1:8787 only. Put Caddy/nginx with https in front, or rerun with --domain <your-dns-name>."
fi
