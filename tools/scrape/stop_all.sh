#!/usr/bin/env bash
# Stop the county driver and the stage it is running. Pass --vllm to stop the vision server too.
cd "$(dirname "$0")/../.."
for p in $(pgrep -f "^bash tools/scrape/run_pipeline.sh$"); do pkill -P "$p"; kill "$p"; echo "stopped driver $p"; done
if [ "${1:-}" = "--vllm" ]; then pkill -f "vllm serve" && echo "stopped vLLM"; fi
