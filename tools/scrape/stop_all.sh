#!/usr/bin/env bash
# Stop every driver loop (acquire, extract, research, or the old single ROLE=all loop) and the stage each is running.
# Pass --vllm to stop the vision server too.
cd "$(dirname "$0")/../.."
for f in data-lake/logs/driver-*.pid; do
  [ -f "$f" ] || continue
  p=$(cat "$f"); role=$(basename "$f" .pid); role=${role#driver-}
  if kill -0 "$p" 2>/dev/null; then pkill -P "$p"; kill "$p"; echo "stopped driver $role (pid $p)"; fi
  rm -f "$f"
done
# anything started before the pid files existed
for p in $(pgrep -f "^bash tools/scrape/run_pipeline.sh$"); do pkill -P "$p"; kill "$p"; echo "stopped stray driver $p"; done
if [ "${1:-}" = "--vllm" ]; then pkill -f "vllm serve" && echo "stopped vLLM"; fi
