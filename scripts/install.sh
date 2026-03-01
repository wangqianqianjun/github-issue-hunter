#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${ISSUE_HUNTER_REPO_URL:-https://github.com/wangqianqianjun/github-issue-hunter.git}"
INSTALL_DIR="${ISSUE_HUNTER_INSTALL_DIR:-$HOME/.github-issue-hunter}"
START_AFTER_INSTALL=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --dir=*)
      INSTALL_DIR="${1#*=}"
      shift
      ;;
    --no-start)
      START_AFTER_INSTALL=0
      shift
      ;;
    --repo)
      REPO_URL="${2:-}"
      shift 2
      ;;
    --repo=*)
      REPO_URL="${1#*=}"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: install.sh [--dir <path>] [--repo <url>] [--no-start]"
      exit 1
      ;;
  esac
done

if [[ -z "$INSTALL_DIR" ]]; then
  echo "Install directory is empty."
  exit 1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

require_cmd git
require_cmd node
require_cmd npm

echo "Install dir: $INSTALL_DIR"
echo "Repo URL: $REPO_URL"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Existing install found, pulling latest changes..."
  git -C "$INSTALL_DIR" fetch --all --tags
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "Cloning repository..."
  rm -rf "$INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

echo "Installing dependencies..."
npm install

echo "Building project..."
npm run build

mkdir -p "$INSTALL_DIR/state/runtime"

if [[ $START_AFTER_INSTALL -eq 1 ]]; then
  echo "Starting service..."
  bash "$INSTALL_DIR/scripts/service.sh" restart
  echo
  echo "Install complete."
  echo "Open UI: http://${HOST:-127.0.0.1}:${PORT:-8787}"
  echo "Service status: bash $INSTALL_DIR/scripts/service.sh status"
else
  echo "Install complete (service not started)."
  echo "Start manually: bash $INSTALL_DIR/scripts/service.sh start"
fi
