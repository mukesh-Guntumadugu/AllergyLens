#!/usr/bin/env bash
# Live view of the scraper: the driver's stage status plus the tail of whatever stage log is being written right now.
#   tools/scrape/watch.sh
cd "$(dirname "$0")/../.."
exec watch -t -n 2 '
echo "=== driver: $(pgrep -f "^bash tools/scrape/run_pipeline.sh$" >/dev/null && echo RUNNING || echo NOT RUNNING)   vLLM: $(curl -s -m 2 -o /dev/null -w "%{http_code}" http://localhost:8000/v1/models)   $(date +%H:%M:%S)"
echo
echo "--- last stages (data-lake/logs/status.log)"
tail -n 6 data-lake/logs/status.log
echo
f=$(ls -t data-lake/logs/2*/*.log 2>/dev/null | head -1)
echo "--- current stage log: $f"
tail -n 18 "$f" | cut -c1-150
echo
echo "--- totals"
printf "restaurants %s | menu assets %s | images judged %s (menus %s) | dish lines %s\n" \
  "$(wc -l < data-lake/silver/restaurants.jsonl 2>/dev/null)" \
  "$(wc -l < data-lake/silver/menu_assets.jsonl 2>/dev/null)" \
  "$(wc -l < data-lake/silver/menu_gate.jsonl 2>/dev/null)" \
  "$(grep -c "\"verdict\": \"menu\"" data-lake/silver/menu_gate.jsonl 2>/dev/null)" \
  "$(wc -l < data-lake/silver/menu_items.jsonl 2>/dev/null)"
'
