#!/usr/bin/env bash
# Stop every driver loop (acquire, extract, research, or the old single ROLE=all loop) and the stage each is running.
# Pass --vllm to stop the vision server too.
cd "$(dirname "$0")/../.."
for f in data-lake/logs/driver-*.pid; do
  [ -f "$f" ] || continue
  p=$(cat "$f"); role=$(basename "$f" .pid); role=${role#driver-}
  # the driver was started with setsid, so its pid is its process group: killing the group takes every stage
  # and every browser those stages launched (killing only the python left Chromium orphans eating memory)
  if kill -0 "$p" 2>/dev/null; then kill -TERM -- "-$p" 2>/dev/null || { pkill -P "$p"; kill "$p"; }; echo "stopped driver $role (pid $p and its process group)"; fi
  rm -f "$f"
done
# anything started before the pid files existed
for p in $(pgrep -f "^bash tools/scrape/run_pipeline.sh$"); do kill -TERM -- "-$p" 2>/dev/null || { pkill -P "$p"; kill "$p"; }; echo "stopped stray driver $p"; done
sleep 2
# browsers nobody owns any more (parent is init): Playwright Chromium left behind by a killed stage
for p in $(ps -eo pid,ppid,args | awk '$2==1 && /ms-playwright/ {print $1}'); do kill -9 "$p" 2>/dev/null; done
if [ "${1:-}" = "--vllm" ]; then pkill -f "vllm serve" && echo "stopped vLLM"; fi
