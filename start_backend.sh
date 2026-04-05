#!/bin/bash
# Start the Spotlight backend server with automatic .env loading

cd "$(dirname "$0")"

echo "🚀 Starting Spotlight backend server..."
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "⚠️  No .env file found!"
    echo "   Create one with: echo 'POKEMONTCG_API_KEY=your_key' > .env"
    echo ""
fi

# Start the server (python-dotenv will load .env automatically)
# Bind to 0.0.0.0 to allow iPhone to connect
# Use --skip-seed to avoid reloading catalog on every start
python3 backend/server.py \
  --cards-file backend/catalog/pokemontcg/cards.json \
  --database-path backend/data/imported_scanner.sqlite \
  --port 8788 \
  --host 0.0.0.0 \
  --skip-seed
