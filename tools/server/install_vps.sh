#!/usr/bin/env bash
# One-time install of the AllergyLens public API on a VPS (Ubuntu 22.04/24.04 or AlmaLinux 9/10, e.g. Hostinger).
# Run from a clone of the repo, as root or a sudo user:
#     git clone https://github.com/mukesh-Guntumadugu/AllergyLens.git ~/allergylens && cd ~/allergylens
#     bash tools/server/install_vps.sh --domain api.example.com
# What it does: node (if missing), a python venv with the research packages, systemd service `allergylens-api`
# on 127.0.0.1:8787, and an https front door for --domain: nginx + certbot when nginx is already running on
# the box (it then only adds one server block and never touches other sites), otherwise Caddy. The Lens gets
# a stable address: https://<domain>/menus.json and https://<domain>/lookup?dish=…
# Afterwards:  systemctl status allergylens-api ; journalctl -u allergylens-api -f
# Data: this box has no scraper; copy the GX10's gold catalog (tools/server/sync_vps.sh does it from the Mac)
# and restart the service whenever it changes. Researched dishes land in data/lookup-cache.json.
set -euo pipefail
DOMAIN=""
while [ $# -gt 0 ]; do case "$1" in --domain) DOMAIN="$2"; shift 2;; *) echo "unknown arg $1"; exit 1;; esac; done
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
USER_NAME="${SUDO_USER:-$(whoami)}"
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
if command -v dnf >/dev/null; then PKG="$SUDO dnf install -y -q"; else PKG="$SUDO apt-get install -y -q"; fi

if ! command -v node >/dev/null; then
  if command -v dnf >/dev/null; then $SUDO dnf module -y enable nodejs:20 >/dev/null 2>&1 || true; $PKG nodejs
  else curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - && $PKG nodejs; fi
fi
NODE_DIR="$(dirname "$(command -v node)")"
command -v python3 >/dev/null || $PKG python3
python3 -c "import venv" 2>/dev/null || $PKG python3-venv
[ -d "$REPO/.venv" ] || python3 -m venv "$REPO/.venv"
"$REPO/.venv/bin/pip" install -q -r "$REPO/tools/server/requirements.txt"
mkdir -p "$REPO/data-lake/gold" "$REPO/data-lake/bronze"
node "$REPO/tools/build-data.js" --with-lake
sed -e "s|__USER__|$USER_NAME|g" -e "s|__REPO__|$REPO|g" -e "s|__NODE_DIR__|$NODE_DIR|g" "$REPO/tools/server/allergylens-api.service" | $SUDO tee /etc/systemd/system/allergylens-api.service >/dev/null
$SUDO systemctl daemon-reload
$SUDO systemctl enable allergylens-api
$SUDO systemctl restart allergylens-api
sleep 2
curl -fsS http://127.0.0.1:8787/health && echo

if [ -z "$DOMAIN" ]; then
  echo "No --domain given: the API listens on 127.0.0.1:8787 only. Rerun with --domain <dns-name-pointing-here> for https."
  exit 0
fi
if systemctl is-active -q nginx; then
  command -v certbot >/dev/null || { if command -v dnf >/dev/null; then $PKG certbot python3-certbot-nginx; else $PKG certbot python3-certbot-nginx; fi; }
  CONF=/etc/nginx/conf.d/allergylens.conf; [ -d /etc/nginx/sites-enabled ] && CONF=/etc/nginx/sites-enabled/allergylens.conf
  $SUDO tee "$CONF" >/dev/null <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host \$host;
        proxy_read_timeout 15s;
    }
}
NGX
  $SUDO nginx -t && $SUDO systemctl reload nginx
  $SUDO certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
else
  if ! command -v caddy >/dev/null; then
    if command -v dnf >/dev/null; then $PKG epel-release; $PKG caddy
    else
      $PKG debian-keyring debian-archive-keyring apt-transport-https curl
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      $SUDO apt-get update && $PKG caddy
    fi
  fi
  printf '%s {\n\treverse_proxy 127.0.0.1:8787\n}\n' "$DOMAIN" | $SUDO tee /etc/caddy/Caddyfile >/dev/null
  $SUDO systemctl enable caddy; $SUDO systemctl reload caddy || $SUDO systemctl restart caddy
fi
echo "Lens Studio: set menusUrl on the AllergyLens object to https://$DOMAIN/menus.json"
echo "Test: node tools/check.js --dish \"chicken tikka masala\" --cuisine indian --profile milk --url https://$DOMAIN/menus.json"
