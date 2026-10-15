#!/bin/sh
set -eu

command -v python3 >/dev/null 2>&1 || { echo "Install Python 3.9+ first." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Install Node.js 20+ first." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT HUP INT TERM
curl -fsSL --retry 3 "https://github.com/TheerasakPing/gemini-argon-web-bridge/archive/refs/heads/main.tar.gz" -o "$task_tmp/argon.tar.gz"
tar -xzf "$task_tmp/argon.tar.gz" -C "$task_tmp"
python3 "$task_tmp/gemini-argon-web-bridge-main/scripts/install.py" "$@"
