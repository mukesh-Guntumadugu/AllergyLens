#!/usr/bin/env bash
# Store a GitHub personal access token for git pushes, without it showing on screen or in shell history.
# Writes ~/.git-credentials (owner-only) in the form git's "store" helper reads, then verifies it with a dry push.
# Usage: tools/scrape/set_github_token.sh     then paste the token at the hidden prompt and press Enter.
set -euo pipefail
USER_NAME="mukesh-Guntumadugu"
read -r -s -p "Paste the GitHub token (ghp_... or github_pat_...), then press Enter (nothing is echoed): " TOKEN
echo
TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]"'"'")
if [ ${#TOKEN} -lt 20 ]; then echo "That is too short to be a token (${#TOKEN} chars). Nothing written."; exit 1; fi
umask 077
printf 'https://%s:%s@github.com\n' "$USER_NAME" "$TOKEN" > ~/.git-credentials
unset TOKEN
git config --global credential.helper store
echo "Saved to ~/.git-credentials. Checking it against GitHub..."
if git -C ~/AllergyLens ls-remote --heads https://github.com/mukesh-Guntumadugu/AllergyLens.git main >/dev/null 2>&1 \
   && git -C ~/AllergyLens push --dry-run origin design/scraper-pipeline-v2 2>&1 | grep -v "^To " ; then
  echo "TOKEN OK: GitHub accepted it. You can tell Claude to push."
else
  echo "TOKEN REJECTED by GitHub. Make a new one at https://github.com/settings/tokens/new with the 'repo' box ticked, then run this again."
  rm -f ~/.git-credentials
  exit 1
fi
