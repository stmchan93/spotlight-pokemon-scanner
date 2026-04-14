#!/bin/bash
# Start the Spotlight backend server with automatic backend/.env loading

cd "$(dirname "$0")"

echo "🚀 Starting Spotlight backend server..."
echo ""

# Check if backend/.env exists
if [ ! -f backend/.env ]; then
    echo "⚠️  No backend/.env file found!"
    echo "   Create one with:"
    echo "   printf 'POKEMONTCG_API_KEY=your_key\\nSCRYDEX_API_KEY=your_key\\nSCRYDEX_TEAM_ID=spotlight\\n' > backend/.env"
    echo ""
fi

# Prefer the visual-model venv so local runtime matches the active backend path.
PYTHON_BIN="python3"
if [ -x ".venv-raw-visual-poc/bin/python" ]; then
    PYTHON_BIN=".venv-raw-visual-poc/bin/python"
fi

# Start the server. backend/server.py will load backend/.env directly.
# Bind to 0.0.0.0 to allow iPhone to connect.
"$PYTHON_BIN" backend/server.py \
  --database-path backend/data/spotlight_scanner.sqlite \
  --port 8788 \
  --host 0.0.0.0
