#!/usr/bin/env bash
# Bring the whole scraper up, detached from whatever shell runs this (survives the terminal or app closing):
#   1. vLLM serving the vision model on :8000 (started only if not already answering)
#   2. the three driver loops, one process each, once vLLM answers:
#        acquire   per county: discover -> websites -> pdfs -> places -> mapsweb -> gate      (network + CPU)
#        extract   label every gated menu image not yet extracted                            (GPU)
#        research  ingredients for every dish not yet in the catalog, then merge/build/db     (network)
#      They overlap, so the GPU works while the crawler and the researcher wait on the web.
# Safe to run again any time: a role already running is left alone (data-lake/logs/driver-<role>.pid).
#
#   tools/scrape/start_all.sh                 # start what is missing
#   ROLES="extract" tools/scrape/start_all.sh # only some roles
#   tools/scrape/stop_all.sh                  # stop the drivers (--vllm: the vision server too)
set -uo pipefail
cd "$(dirname "$0")/../.."
LOGS=data-lake/logs; mkdir -p "$LOGS"
MODEL=${VLM_MODEL:-Qwen/Qwen3-VL-8B-Instruct}
PORT=${VLM_PORT:-8000}
ROLES=${ROLES:-acquire gate extract research}
ACQUIRE_PARALLEL=${ACQUIRE_PARALLEL:-4}      # counties acquired at the same time (one process each); the GPU starves on one
export VLM_API=openai VLM_BASE_URL="http://localhost:$PORT/v1" VLM_MODEL="$MODEL" LOOP=${LOOP:-1}

vllm_up() { curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:$PORT/v1/models" 2>/dev/null | grep -q 200; }

if vllm_up; then
  echo "vLLM already serving on :$PORT"
else
  if pgrep -f "vllm serve" >/dev/null; then
    echo "vLLM is starting (process exists, not answering yet)"
  else
    echo "starting vLLM ($MODEL) -> $LOGS/vllm.log"
    # 0.60 of the 121 GB unified memory: ~17 GB weights, the rest KV cache so 16-32 menu images can be labelled at once
    setsid nohup vllm serve "$MODEL" --port "$PORT" --max-model-len 16384 --gpu-memory-utilization "${VLLM_GPU_FRACTION:-0.60}" \
      --max-num-seqs "${VLLM_MAX_SEQS:-32}" \
      >> "$LOGS/vllm.log" 2>&1 < /dev/null &
  fi
  for i in $(seq 1 120); do          # up to 10 minutes for the model to load
    sleep 5
    if vllm_up; then echo "vLLM ready after $((i * 5))s"; break; fi
    if [ "$i" = 120 ]; then echo "vLLM did not come up in 10 min; see $LOGS/vllm.log"; exit 1; fi
  done
fi

alive() { [ -f "$LOGS/driver-$1.pid" ] && kill -0 "$(cat "$LOGS/driver-$1.pid")" 2>/dev/null; }

if alive all; then
  echo "the old single-loop driver (ROLE=all, pid $(cat "$LOGS/driver-all.pid")) is running; stop it with tools/scrape/stop_all.sh before starting the role loops"
  exit 1
fi
# does this driver know shards and a gate role? (older run_pipeline.sh: one acquire, gate inside it)
if grep -q "ACQUIRE_SHARD" tools/scrape/run_pipeline.sh && grep -q "gate)" tools/scrape/run_pipeline.sh; then SHARDED=1; else SHARDED=0; ROLES=${ROLES//gate/}; ACQUIRE_PARALLEL=1; fi
start_role() {  # start_role <role> <pidname> [extra env assignments...]
  local role=$1 name=$2; shift 2
  if alive "$name"; then
    echo "driver $name already running (pid $(cat "$LOGS/driver-$name.pid"))"
  else
    env "$@" ROLE=$role setsid nohup tools/scrape/run_pipeline.sh >> "$LOGS/driver-$name.out" 2>&1 < /dev/null &
    sleep 2
    echo "driver $name started (pid $(cat "$LOGS/driver-$name.pid" 2>/dev/null || echo '?'))"
  fi
}
for role in $ROLES; do
  if [ "$role" = acquire ] && [ "$SHARDED" = 1 ] && [ "$ACQUIRE_PARALLEL" -gt 1 ]; then
    for k in $(seq 0 $((ACQUIRE_PARALLEL - 1))); do start_role acquire "acquire-$k" "ACQUIRE_SHARD=$k/$ACQUIRE_PARALLEL"; done
  else
    start_role "$role" "$role"
  fi
done
echo "watch it with tools/scrape/watch.sh"
