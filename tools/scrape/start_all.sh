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
ROLES=${ROLES:-acquire extract research}
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
for role in $ROLES; do
  if alive "$role"; then
    echo "driver $role already running (pid $(cat "$LOGS/driver-$role.pid"))"
  else
    ROLE=$role setsid nohup tools/scrape/run_pipeline.sh >> "$LOGS/driver-$role.out" 2>&1 < /dev/null &
    sleep 2
    echo "driver $role started (pid $(cat "$LOGS/driver-$role.pid" 2>/dev/null || echo '?'))"
  fi
done
echo "watch it with tools/scrape/watch.sh"
