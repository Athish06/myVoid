#!/usr/bin/env bash
set -euo pipefail

if [ ! -f package.json ]; then
  echo "No package.json found; skipping electron detection"
  exit 0
fi

EV=$(node -e "try{const p=require('./package.json'); console.log((p.devDependencies&&p.devDependencies.electron) || (p.dependencies&&p.dependencies.electron)|| '');}catch(e){console.log('')}" || true)
EV=${EV:-}
if [ -n "$EV" ]; then
  echo "Setting npm/node-gyp electron env for $EV"
  npm config set target "$EV" || true
  npm config set runtime electron || true
  npm config set disturl https://atom.io/download/electron || true
  npm config set build_from_source true || true
else
  echo "Electron not found in package.json"
fi
