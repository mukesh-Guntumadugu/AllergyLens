#!/usr/bin/env bash
# SQL prompt on the scraper database (see db_shell.py). Usage: tools/scrape/db.sh ["SQL"] [--sqlite]
cd "$(dirname "$0")/../.."
exec .venv/bin/python tools/scrape/db_shell.py "$@"
