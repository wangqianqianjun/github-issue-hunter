#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"
echo "Installing dependencies..."
npm install

echo "Building project..."
npm run build

echo "Starting service..."
bash "$ROOT_DIR/scripts/service.sh" restart

echo
echo "Done. Open: http://${HOST:-127.0.0.1}:${PORT:-8787}"
