# syntax=docker/dockerfile:1
#
# Spotlight backend — portable image (Hetzner CCX / DO droplet / GCP).
#   docker build --platform linux/amd64 -t spotlight-backend .
#
# LAYOUT (important): server.py computes repo_root as <server.py dir>.parent, and
# the ONNX encoder path is <backend dir>/data/visual-models/...  So the code MUST
# live at /app/backend (NOT /app) for the `backend/data/...` paths in .env.production
# to resolve unchanged. The 1.7 GB runtime data slice is a volume at
# /app/backend/data — never baked into the image (see .dockerignore).

ARG PYTHON_VERSION=3.13
FROM --platform=linux/amd64 python:${PYTHON_VERSION}-slim AS base

# torch is a hard dep (raw_visual_model.py imports it) installed from the CPU wheel
# index, mirroring deploy_to_vm.sh — not PyPI.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
ARG TORCH_PACKAGE_SPEC=torch==2.11.0+cpu

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/app/backend/data/hf-cache \
    SPOTLIGHT_HOST=0.0.0.0 \
    SPOTLIGHT_PORT=8788 \
    SPOTLIGHT_DATABASE_PATH=/app/backend/data/spotlight_scanner.sqlite

WORKDIR /app

# libgomp1: OpenMP runtime for onnxruntime/torch CPU threading.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# Deps first for layer caching: torch-cpu wheel, then requirements.vm.txt.
COPY requirements.vm.txt /app/backend/requirements.vm.txt
RUN python -m pip install --upgrade pip setuptools wheel \
 && python -m pip install --index-url "${TORCH_INDEX_URL}" "${TORCH_PACKAGE_SPEC}" \
 && python -m pip install -r /app/backend/requirements.vm.txt

# App code at /app/backend (data/ excluded via .dockerignore, mounted at runtime).
COPY . /app/backend

EXPOSE 8788

# Model load + first-run HF processor download can take a bit — generous start-period.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('SPOTLIGHT_PORT','8788')+'/api/v1/health').read()" || exit 1

# repo_root resolves to /app; backend/data/... paths from .env.production work as-is.
CMD python backend/server.py \
      --host "${SPOTLIGHT_HOST}" \
      --port "${SPOTLIGHT_PORT}" \
      --database-path "${SPOTLIGHT_DATABASE_PATH}"
