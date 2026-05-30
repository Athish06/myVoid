#!/usr/bin/env bash
set -euo pipefail

echo "Bootstrapping Codespace: installing system packages..."

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
    build-essential g++-11 gcc make python3 python3-dev python3-pip cmake pkg-config \
    libkrb5-dev libx11-dev libxkbfile-dev libxcb1-dev libgtk-3-dev libsecret-1-dev \
    libssl-dev ca-certificates
  # Prefer g++-11 if available
  if [ -x /usr/bin/g++-11 ]; then
    update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-11 100 || true
  fi
else
  echo "Non-debian host detected; ensure you have a C++20-capable toolchain, python3, cmake, and build tools installed."
fi

export CC=/usr/bin/gcc
export CXX=/usr/bin/g++
export CXXFLAGS='-std=c++20 -fconcepts'

echo "Detecting Electron version and configuring npm/node-gyp..."
if [ -f package.json ]; then
  EV=$(node -e "try{const p=require('./package.json'); console.log((p.devDependencies&&p.devDependencies.electron) || (p.dependencies&&p.dependencies.electron)|| '');}catch(e){console.log('')}" || true)
  EV=${EV:-}
  if [ -n "$EV" ]; then
    echo "Found electron: $EV"
    npm config set target "$EV" || true
    npm config set runtime electron || true
    npm config set disturl https://atom.io/download/electron || true
    npm config set build_from_source true || true
  fi
fi

echo "Cleaning and installing node modules (may take a while)..."
rm -rf node_modules build/node_modules package-lock.json || true
npm cache clean --force || true
npm ci --unsafe-perm --no-audit --no-fund

echo "Bootstrap complete."
