#!/usr/bin/env bash
set -euo pipefail

SERVICE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SERVICE_ROOT"

VENV_DIR="$SERVICE_ROOT/.venv"
PYTHON="$VENV_DIR/bin/python"
PIP="$VENV_DIR/bin/pip"

if [[ ! -x "$PYTHON" ]]; then
  echo "Creating virtual environment..."
  python3 -m venv "$VENV_DIR"
fi

if [[ "${1:-}" != "--skip-install" ]]; then
  echo "Installing dependencies..."
  "$PYTHON" -m pip install --upgrade pip
  "$PIP" install -r requirements.txt
fi

if [[ ! -f "$SERVICE_ROOT/.env" ]]; then
  cp "$SERVICE_ROOT/.env.example" "$SERVICE_ROOT/.env"
  echo "Created .env from .env.example"
fi

echo "Starting LLM service..."
exec "$PYTHON" main.py
