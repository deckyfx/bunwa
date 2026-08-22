#!/usr/bin/env bash
# Refresh the read-only gowa reference clone to the latest upstream main.
set -euo pipefail

REPO_URL="https://github.com/aldinokemal/go-whatsapp-web-multidevice.git"
DIR="$(cd "$(dirname "$0")/.." && pwd)/reference/gowa"

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --depth 1 origin main
  git -C "$DIR" checkout -q main
  git -C "$DIR" reset --hard -q origin/main
else
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 --branch main "$REPO_URL" "$DIR"
fi

git -C "$DIR" log -1 --format='gowa reference now at %h (%ad) %s' --date=short
