#!/usr/bin/env bash
# AllergyLens scraper driver: every stage in order, for a list of counties, unattended.
#
# Start it once and leave it (tmux / nohup / systemd). Each stage is idempotent and
# resumable, so if the box reboots you just start it again and it continues. Logs go to
# data-lake/logs/<timestamp>/<stage>.log; a one-line status per stage to data-lake/logs/status.log.
#
#   tools/scrape/run_pipeline.sh                      # counties from tools/scrape/counties.txt
#   tools/scrape/run_pipeline.sh "Ohio|OH|Athens County" "Ohio|OH|Hocking County"
#   LOOP=1 tools/scrape/run_pipeline.sh               # when done, start over (re-checks for changed menus)
#
# Optional env: GOOGLE_PLACES_API_KEY (enables the Places API photo lane), VISION_MODEL (default auto),
# ALLOW_GOOGLE_MAPS_WEB=1 (the web adapter; see DESIGN.md §0.8 — it stops by itself on the limited view),
# SKIP="stage names" to skip stages, e.g. SKIP="websites".
set -uo pipefail
cd "$(dirname "$0")/../.."
PY=".venv/bin/python -u"   # -u: unbuffered, so logs are live
TS=$(date +%Y%m%d-%H%M%S); LOGDIR=data-lake/logs/$TS; mkdir -p "$LOGDIR"
STATUS=data-lake/logs/status.log
VISION_MODEL=${VISION_MODEL:-auto}
SKIP=${SKIP:-}

log()   { echo "$(date -Is) $*" | tee -a "$STATUS"; }
stage() {  # stage <name> <command...>   runs, logs, never aborts the whole run
  local name=$1; shift
  if [[ " $SKIP " == *" $name "* ]]; then log "skip  $name"; return 0; fi
  log "start $name"
  if "$@" >"$LOGDIR/$name.log" 2>&1; then log "ok    $name"; else log "FAIL  $name (exit $?) see $LOGDIR/$name.log"; fi
}

COUNTIES=("$@")
if [ ${#COUNTIES[@]} -eq 0 ]; then
  mapfile -t COUNTIES < <(grep -v '^\s*#' tools/scrape/counties.txt | grep -v '^\s*$')
fi

while :; do
  for spec in "${COUNTIES[@]}"; do
    # secrets and switches live in .env at the repo root (gitignored); re-read every county so a key
    # added while the driver runs takes effect without a restart. Lines: NAME=value, no quotes needed.
    if [ -f .env ]; then set -a; . ./.env; set +a; fi
    IFS="|" read -r STATE CODE COUNTY FIPS <<<"$spec"
    log "=== $COUNTY, $CODE ==="
    stage discover   $PY tools/scrape/discover_restaurants.py --state "$STATE" --state-code "$CODE" --county "$COUNTY"
    stage websites   $PY tools/scrape/acquire_websites.py
    stage pdfs       $PY tools/scrape/pdf_menus.py
    if [ -n "${GOOGLE_PLACES_API_KEY:-}" ]; then
      stage places   $PY tools/scrape/sources/places_api_photos.py --from-restaurants
    else
      log "skip  places (no GOOGLE_PLACES_API_KEY)"
    fi
    if [ "${ALLOW_GOOGLE_MAPS_WEB:-0}" = "1" ]; then
      $PY - <<'PYEOF' > data-lake/silver/maps_jobs.jsonl
import json
for l in open("data-lake/silver/restaurants.jsonl"):
    r = json.loads(l); q = ", ".join(x for x in [r["name"], r.get("address"), r.get("city") or r["county"], r["state"]] if x)
    print(json.dumps({"query": q, "restaurant_id": r["restaurant_id"]}))
PYEOF
      if command -v xvfb-run >/dev/null; then
        stage mapsweb xvfb-run -a $PY tools/scrape/sources/google_maps_web.py --allow-google-maps-web --headed --jobs data-lake/silver/maps_jobs.jsonl
      else
        log "skip  mapsweb (needs xvfb-run for a windowed browser: sudo apt install -y xvfb)"
      fi
    fi
    stage gate       $PY tools/scrape/gate_menu_images.py --vision-model "$VISION_MODEL"
    stage process    $PY tools/scrape/process_menus.py --vision-model "$VISION_MODEL" --state "$CODE" --county "${COUNTY% County}"
    GOLD="data-lake/gold/menus.$(echo "$CODE" | tr A-Z a-z)-$(echo "${COUNTY% County}" | tr A-Z a-z | tr ' ' '-').json"
    if [ -f "$GOLD" ]; then
      stage research $PY tools/scrape/ingredients_rag.py "$GOLD"
    else
      log "skip  research (no gold file yet: $GOLD)"
    fi
    stage build      node tools/build-data.js --with-lake
  done
  [ "${LOOP:-0}" = "1" ] || break
  log "loop: sleeping 6h before the next pass"; sleep 6h
done
log "done"
