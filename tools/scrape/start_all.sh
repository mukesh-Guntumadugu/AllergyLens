#!/usr/bin/env bash
# Bring the whole scraper up, detached from whatever shell runs this (survives the terminal or app closing):
#   1. vLLM serving the vision model on :8000 (started only if not already answering)
#   2. the county driver (run_pipeline.sh, LOOP=1) once vLLM answers
# Safe to run again any time: it never starts a second copy of either.
#
#   tools/scrape/start_all.sh            # start what is missing
#   tools/scrape/stop_all.sh             # stop the driver (vLLM stays up unless you pass --vllm)
set -uo pipefail
cd "$(dirname "$0")/../.."
LOGS=data-lake/logs; mkdir -p "$LOGS"
MODEL=${VLM_MODEL:-Qwen/Qwen3-VL-8B-Instruct}
PORT=${VLM_PORT:-8000}
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

if pgrep -f "^bash tools/scrape/run_pipeline.sh$" >/dev/null; then
  echo "driver already running (pid $(pgrep -f '^bash tools/scrape/run_pipeline.sh$' | head -1))"
else
  setsid nohup tools/scrape/run_pipeline.sh >> "$LOGS/driver.out" 2>&1 < /dev/null &
  sleep 3
  pgrep -f "^bash tools/scrape/run_pipeline.sh$" | head -1 > "$LOGS/driver.pid"
  echo "driver started, pid $(cat "$LOGS/driver.pid"); watch it with tools/scrape/watch.sh"
fi
