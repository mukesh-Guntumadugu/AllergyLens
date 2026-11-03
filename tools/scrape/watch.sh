#!/usr/bin/env bash
# Live view of the scraper: each driver loop's state, the last status lines, the tail of the newest stage log, totals.
#   tools/scrape/watch.sh
cd "$(dirname "$0")/../.."
exec watch -t -n 2 '
printf "=== %s   vLLM: %s   load: %s\n" "$(date +%H:%M:%S)" "$(curl -s -m 2 -o /dev/null -w "%{http_code}" http://localhost:8000/v1/models)" "$(cut -d" " -f1-3 /proc/loadavg)"
for f in data-lake/logs/driver-*.pid; do
  [ -f "$f" ] || continue
  role=$(basename "$f" .pid); role=${role#driver-}
  if kill -0 "$(cat "$f")" 2>/dev/null; then st="RUNNING pid $(cat "$f")"; else st="not running"; fi
  printf "  %-11s %s\n" "$role" "$st"
done
echo
echo "--- last stage lines (data-lake/logs/status.log)"
tail -n 8 data-lake/logs/status.log | cut -c1-150
echo
f=$(ls -t data-lake/logs/2*/*.log 2>/dev/null | head -1)
echo "--- newest stage log: $f"
tail -n 14 "$f" | cut -c1-150
echo
echo "--- totals"
printf "restaurants %s | menu assets %s | gallery photos %s | images judged %s (menus %s) | dish lines %s | dishes researched %s\n" \
  "$(wc -l < data-lake/silver/restaurants.jsonl 2>/dev/null)" \
  "$(wc -l < data-lake/silver/menu_assets.jsonl 2>/dev/null)" \
  "$(wc -l < data-lake/silver/menu_photos.jsonl 2>/dev/null)" \
  "$(wc -l < data-lake/silver/menu_gate.jsonl 2>/dev/null)" \
  "$(grep -c "\"verdict\": \"menu\"" data-lake/silver/menu_gate.jsonl 2>/dev/null)" \
  "$(wc -l < data-lake/silver/menu_items.jsonl 2>/dev/null)" \
  "$(python3 -c "import json;print(len(json.load(open(\"data-lake/gold/dishes.json\"))[\"dishes\"]))" 2>/dev/null)"
'
