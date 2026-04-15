#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  start_backend.sh  –  Launch the FactCheck FastAPI server
#  Usage: ./start_backend.sh [path-to-model]
# ─────────────────────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODEL_PATH="${1:-$SCRIPT_DIR/factcheck-model}"

echo "────────────────────────────────────────"
echo "  🔍 FactCheck ML Backend"
echo "────────────────────────────────────────"
echo "  Model path : $MODEL_PATH"
echo "  Server     : http://localhost:8000"
echo "────────────────────────────────────────"

if [ ! -d "$MODEL_PATH" ]; then
  echo ""
  echo "❌  ERROR: Model directory not found at:"
  echo "    $MODEL_PATH"
  echo ""
  echo "   Place your downloaded factcheck-model folder here,"
  echo "   or pass the path as an argument:"
  echo "   ./start_backend.sh /path/to/factcheck-model"
  echo ""
  exit 1
fi

# Install deps if needed
if ! python3 -c "import fastapi" 2>/dev/null; then
  echo ""
  echo "📦 Installing Python dependencies..."
  pip install -r "$SCRIPT_DIR/requirements.txt"
fi

echo ""
echo "🚀 Starting server..."
echo ""

export MODEL_PATH="$MODEL_PATH"
cd "$SCRIPT_DIR"
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
