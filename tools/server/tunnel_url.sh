#!/usr/bin/env bash
# Print the data server's current public https address (from the tunnel service's log).
#   bash tools/server/tunnel_url.sh [user@host]        default mukesh@gx10-733b.local
HOST="${1:-mukesh@gx10-733b.local}"
ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" 'journalctl -u allergylens-tunnel --no-pager -o cat 2>/dev/null | grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" | tail -1'
