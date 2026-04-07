FROM python:3.14-slim

WORKDIR /app

# Copy all backend files
COPY . /app

# Install dependencies if requirements.txt exists
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi

# Set environment variable for port
ENV PORT=8080

# Run the server (auto-import mode - no seed file needed!)
CMD python server.py \
    --skip-seed \
    --port ${PORT} \
    --host 0.0.0.0
