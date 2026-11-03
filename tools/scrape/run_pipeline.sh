#!/usr/bin/env bash
# AllergyLens scraper driver, unattended. Every stage is idempotent and resumes from the lake, so if the
# box reboots you just start it again. Logs: data-lake/logs/<timestamp>-<role>/<stage>.log; one status
# line per stage in data-lake/logs/status.log, prefixed with the role.
#
# ROLE picks which loop this process runs. Run the three network/GPU/CPU-bound loops as three processes
# so none waits for the others (the GPU idles during crawling, the cores idle during labelling):
#
#   ROLE=acquire  tools/scrape/run_pipeline.sh    # per county: discover -> websites -> pdfs -> places -> mapsweb (network)
#     ACQUIRE_SHARD=k/N ROLE=acquire ...          # this process takes counties i with i % N == k, so N acquires run at once
#   ROLE=gate     tools/scrape/run_pipeline.sh    # judge every collected image not yet judged (CPU OCR + vision), then sleep
#   ROLE=extract  tools/scrape/run_pipeline.sh    # label every gated menu image not yet extracted (GPU), then sleep
#   ROLE=research tools/scrape/run_pipeline.sh    # ingredients for every dish not yet in the catalog (web), then
#                                                 # merge -> build -> db, then sleep
#   tools/scrape/run_pipeline.sh                  # ROLE=all: the old single sequential loop (tests, small runs)
#
#   tools/scrape/run_pipeline.sh "Ohio|OH|Athens County" "Ohio|OH|Hocking County"   # counties (acquire/all)
#   LOOP=1 ...        acquire/all: when all counties are done, start over (re-checks for changed menus);
#                     extract/research always loop (ONCE=1 runs a single pass of any role, for tests)
#
# One process per role: a second start of the same role exits at once (data-lake/logs/driver-<role>.pid,
# driver-acquire-<k>.pid for a sharded acquire).
# tools/scrape/start_all.sh / stop_all.sh start and stop all of them.
#
# Optional env: GOOGLE_PLACES_API_KEY (Places API photo lane), VISION_MODEL (default auto), PROCESS_WORKERS,
# OCR_WORKERS, VISION_WORKERS (see process_menus.py / gate_menu_images.py), RESEARCH_WORKERS (default 4),
# ALLOW_GOOGLE_MAPS_WEB=1 (the web adapter; see DESIGN.md §0.8), SKIP="stage names" to skip stages,
# IDLE_SLEEP (seconds an extract/research loop waits when it finds nothing to do; default 120).
set -uo pipefail
cd "$(dirname "$0")/../.."
PY=".venv/bin/python -u"   # -u: unbuffered, so logs are live
ROLE=${ROLE:-all}
case "$ROLE" in acquire|gate|extract|research|all) ;; *) echo "ROLE must be acquire, gate, extract, research or all (got '$ROLE')"; exit 2;; esac
SHARD_K=0; SHARD_N=1; TAG=$ROLE
if [ -n "${ACQUIRE_SHARD:-}" ]; then
  [ "$ROLE" = acquire ] || { echo "ACQUIRE_SHARD only applies to ROLE=acquire"; exit 2; }
  SHARD_K=${ACQUIRE_SHARD%%/*}; SHARD_N=${ACQUIRE_SHARD##*/}
  [[ "$SHARD_K" =~ ^[0-9]+$ && "$SHARD_N" =~ ^[0-9]+$ && "$SHARD_K" -lt "$SHARD_N" ]] || { echo "ACQUIRE_SHARD must be k/N with k < N (got '$ACQUIRE_SHARD')"; exit 2; }
  TAG=acquire-$SHARD_K
fi
TS=$(date +%Y%m%d-%H%M%S); LOGDIR=data-lake/logs/$TS-$TAG; mkdir -p "$LOGDIR"
STATUS=data-lake/logs/status.log
VISION_MODEL=${VISION_MODEL:-auto}
SKIP=${SKIP:-}
IDLE_SLEEP=${IDLE_SLEEP:-120}

# one process per role
PIDFILE=data-lake/logs/driver-$TAG.pid
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && grep -q run_pipeline "/proc/$(cat "$PIDFILE")/cmdline" 2>/dev/null; then
  echo "$TAG already running (pid $(cat "$PIDFILE")); not starting a second one"; exit 0
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

log()   { echo "$(date -Is) [$TAG] $*" | tee -a "$STATUS"; }
stage() {  # stage <name> <command...>   runs, logs, never aborts the whole run; returns the command's status
  local name=$1; shift
  if [[ " $SKIP " == *" $name "* ]]; then log "skip  $name"; return 0; fi
  log "start $name"
  if "$@" >"$LOGDIR/$name.log" 2>&1; then log "ok    $name"; return 0; else local rc=$?; log "FAIL  $name (exit $rc) see $LOGDIR/$name.log"; return $rc; fi
}
load_env() {  # secrets and switches live in .env at the repo root (gitignored); re-read often so a key added while
              # the driver runs takes effect without a restart. Lines: NAME=value, no quotes needed.
  if [ -f .env ]; then set -a; . ./.env; set +a; fi
}

# ── stage groups ─────────────────────────────────────────────────────────────────────────────────────
acquire_county() {  # <spec>  returns 1 when discovery failed (caller re-queues the county)
  local spec=$1 STATE CODE COUNTY FIPS ok attempt
  load_env
  IFS="|" read -r STATE CODE COUNTY FIPS <<<"$spec"
  log "=== $COUNTY, $CODE ==="
  # Overpass (OpenStreetMap) mirrors time out now and then: retry a few times, then put the county at the
  # end of the queue instead of recording it as a county with no restaurants
  ok=0
  for attempt in 1 2 3; do
    if stage discover $PY tools/scrape/discover_restaurants.py --state "$STATE" --state-code "$CODE" --county "$COUNTY"; then ok=1; break; fi
    log "discover attempt $attempt failed; waiting 2 min"; sleep 120
  done
  [ $ok = 1 ] || return 1
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
  # the gate runs in its own loop (ROLE=gate) so N acquire shards never judge the same image twice
  [ "$ROLE" = all ] && stage gate $PY tools/scrape/gate_menu_images.py --vision-model "$VISION_MODEL"
  return 0
}

gate_pass() {  # judge every collected image not yet in menu_gate.jsonl
  stage gate $PY tools/scrape/gate_menu_images.py --vision-model "$VISION_MODEL"
  ! grep -q "^0 images to judge" "$LOGDIR/gate.log" 2>/dev/null     # 0 = did work, 1 = nothing new
}

county_files() {  # one menus.<code>-<county>.json per county from the per-restaurant gold files (what research and the review page read)
  $PY - <<'PYEOF'
import json, re
from pathlib import Path
lake = Path("data-lake"); gold = lake / "gold" / "menus"
where = {}
for l in (lake / "silver" / "restaurants.jsonl").read_text().splitlines():
    if l.strip():
        r = json.loads(l); where[r["restaurant_id"]] = ((r.get("state_code") or r.get("state") or "").lower(), (r.get("county") or "").lower())
by_county = {}
for p in sorted(gold.glob("*.json")):
    e = json.loads(p.read_text()); rid = e.get("id") or e.get("restaurant_id") or p.stem
    by_county.setdefault(where.get(rid, ("", "")), []).append(e)
n = 0
for (code, county), rs in by_county.items():
    if not code or not county: continue
    out = lake / "gold" / f"menus.{code}-{re.sub(r'[^a-z0-9]+', '-', county)}.json"
    out.write_text(json.dumps({"version": 1, "restaurants": rs}, indent=2, ensure_ascii=False) + "\n"); n += 1
print(f"{n} county files from {sum(len(v) for v in by_county.values())} restaurant entries")
PYEOF
}

extract_pass() {  # label every gated menu image not yet in menu_items.jsonl (county-free), then refresh the county files
  local before after
  before=$(wc -l < data-lake/silver/menu_items.jsonl 2>/dev/null || echo 0)
  stage process $PY tools/scrape/process_menus.py --vision-model "$VISION_MODEL" --state _ --county _
  rm -f "data-lake/gold/menus._-_.json"
  stage county_files county_files
  after=$(wc -l < data-lake/silver/menu_items.jsonl 2>/dev/null || echo 0)
  [ "$after" != "$before" ]     # 0 = did work, 1 = nothing new
}

research_pass() {  # every dish of every extracted restaurant not yet in the catalog (cache-first), then publish
  local did=1
  $PY - <<'PYEOF' > data-lake/silver/research_input.json
import json
from pathlib import Path
rs = [json.loads(p.read_text()) for p in sorted(Path("data-lake/gold/menus").glob("*.json"))]
print(json.dumps({"version": 1, "restaurants": rs}))
PYEOF
  stage research $PY tools/scrape/ingredients_rag.py data-lake/silver/research_input.json --workers "${RESEARCH_WORKERS:-4}" ${RESEARCH_ARGS:-}
  grep -q "^0 dishes to research" "$LOGDIR/research.log" 2>/dev/null || did=0
  stage merge      $PY tools/scrape/merge_gold.py
  stage build      node tools/build-data.js --with-lake
  stage db         $PY tools/scrape/build_db.py
  return $did
}

# ── loops ────────────────────────────────────────────────────────────────────────────────────────────
COUNTIES=("$@")
if [ ${#COUNTIES[@]} -eq 0 ]; then
  mapfile -t COUNTIES < <(grep -v '^\s*#' tools/scrape/counties.txt | grep -v '^\s*$')
fi
if [ "$SHARD_N" -gt 1 ]; then   # this shard's slice of the county list, in list order
  SHARDED=(); i=0
  for spec in "${COUNTIES[@]}"; do [ $((i % SHARD_N)) = "$SHARD_K" ] && SHARDED+=("$spec"); i=$((i + 1)); done
  COUNTIES=("${SHARDED[@]}")
  log "driver up: ROLE=$ROLE shard $SHARD_K/$SHARD_N (${#COUNTIES[@]} counties) pid $$ logs $LOGDIR"
else
  log "driver up: ROLE=$ROLE pid $$ logs $LOGDIR"
fi

case "$ROLE" in
  acquire|all)
    RETRY=()
    while :; do
      # groceries once per pass (shard 0 only): packaged products with their ingredient-label photos (Open Food Facts)
      [ "$SHARD_K" = 0 ] && stage products $PY tools/scrape/fetch_products.py --categories-file tools/scrape/product_categories.txt --n ${PRODUCTS_PER_CATEGORY:-100} --out data-lake/gold/products.json
      for spec in "${COUNTIES[@]}"; do
        if ! acquire_county "$spec"; then
          log "requeue $spec (discovery failed 3 times; retried at the end of the pass)"; RETRY+=("$spec"); continue
        fi
        if [ "$ROLE" = all ]; then
          extract_pass || true
          research_pass || true
        fi
      done
      if [ ${#RETRY[@]} -gt 0 ] && [ "${LOOP:-0}" != "1" ]; then
        log "retrying ${#RETRY[@]} counties whose discovery failed"
        COUNTIES=("${RETRY[@]}"); RETRY=(); continue
      fi
      [ "${ONCE:-0}" = "1" ] && break
      [ "${LOOP:-0}" = "1" ] || break
      log "loop: sleeping 6h before the next pass"; sleep 6h
    done
    ;;
  gate)
    while :; do
      load_env
      if gate_pass; then :; else log "idle: no new images to judge; sleeping ${IDLE_SLEEP}s"; [ "${ONCE:-0}" = "1" ] || sleep "$IDLE_SLEEP"; fi
      [ "${ONCE:-0}" = "1" ] && break
    done
    ;;
  extract)
    while :; do
      load_env
      if extract_pass; then :; else log "idle: no new menu images; sleeping ${IDLE_SLEEP}s"; [ "${ONCE:-0}" = "1" ] || sleep "$IDLE_SLEEP"; fi
      [ "${ONCE:-0}" = "1" ] && break
    done
    ;;
  research)
    while :; do
      load_env
      if research_pass; then :; else log "idle: no new dishes; sleeping ${IDLE_SLEEP}s"; [ "${ONCE:-0}" = "1" ] || sleep "$IDLE_SLEEP"; fi
      [ "${ONCE:-0}" = "1" ] && break
    done
    ;;
esac
log "done"
