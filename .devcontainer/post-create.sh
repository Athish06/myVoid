#!/usr/bin/env bash
set -euo pipefail

echo "Running Codespace bootstrap"
if [ -x scripts/bootstrap-local.sh ]; then
	sudo bash scripts/bootstrap-local.sh
else
	echo "No scripts/bootstrap-local.sh found; falling back to 'npm ci'"
	npm ci --unsafe-perm --no-audit --no-fund
fi

echo "Post-create finished."
