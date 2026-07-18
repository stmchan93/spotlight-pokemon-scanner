# Containerized backend — portability + hardware benchmark

Makes the backend run identically on Hetzner CCX / DigitalOcean / GCP, so moving
clouds (or back) is a redeploy, not a rewrite. Image = code + Python deps only; the
**1.7 GB runtime data slice** is a mounted volume (the full dev tree is 54 GB — you
don't move that).

## Two findings that de-risk the move
- **Scan artifacts have a `filesystem` mode** — compose defaults to it, so the box
  writes artifacts to its own disk and needs **no GCP at all**. (Prod currently uses
  `gcs`/`looty-staging`; note the labeling tools read from that bucket, so keep `gcs`
  if you want new scans to keep flowing to labeling — set `STORAGE=gcs` + mount creds.)
- **The runtime slice is 1.7 GB**, not 54 GB: the prod SQLite DB + the active SigLIP2
  index/adapter/onnx. `tools/stage_runtime_data.sh` copies exactly those.

## Why the image puts code at `/app/backend`
`server.py` derives `repo_root = <server.py dir>.parent` and the ONNX path is
`<backend dir>/data/visual-models/...`. Keeping code at `/app/backend` (data at
`/app/backend/data`) means the `backend/data/...` paths in `.env.production` resolve
**unchanged** — no path rewriting, exact parity with the VM.

## Build
```bash
docker build --platform linux/amd64 -t spotlight-backend .
```
Python pinned to **3.13** (your dev venv is 3.13.9). Override: `--build-arg PYTHON_VERSION=…`,
`--build-arg TORCH_PACKAGE_SPEC=…`. torch comes from the CPU wheel index (mirrors `deploy_to_vm.sh`).

## Run on the box
```bash
cp stack.env.example stack.env                 # fill the ~12 secret lines at the bottom
# stage + upload the 1.7 GB runtime slice (run on your Mac from repo root):
backend/tools/stage_runtime_data.sh /tmp/spotlight-data
rsync -avP /tmp/spotlight-data/ user@box:/opt/spotlight/backend/data/
# on the box:
docker compose up -d --build
curl localhost:8788/api/v1/health
```
First boot downloads the SigLIP2 **processor** from HuggingFace into `data/hf-cache`
(needs outbound network once; then cached in the volume).

## Benchmark before you commit (apples-to-apples)
Run the SAME command on the current GCP box and a candidate Hetzner CCX; compare
`model_forward` p50/p95 (the ~60 ms encoder) and the cold price-query p50/p95. The
header prints the actual CPU (t2d = EPYC Milan vs CCX = EPYC).
```bash
docker compose exec backend python backend/tools/bench_hetzner.py --iters 100
```
Spin up one CCX for an hour (a few $), stage the slice, run it. If the encoder lands
near the GCP number and the price query is fine, the move is safe and reversible.

## Scaling for shows
Same as GCP resize: bump the CPU cap in `docker-compose.yml`
(`deploy.resources.limits.cpus: "4" -> "16"`) and the concurrency levers
(`SPOTLIGHT_MAX_CONCURRENT_SCAN_INFERENCES` / `_HEAVY_READS`), then `docker compose up -d`.
More cores = more concurrent scanners (throughput), not faster single scans.

## Pre-flight checklist (all verified in-repo)
- [x] Web server: stdlib `ThreadingHTTPServer` — no gunicorn/uvicorn needed.
- [x] Health route: `GET /api/v1/health` (used by the container HEALTHCHECK).
- [x] Deps: `requirements.vm.txt` + `torch==2.11.0+cpu` from the CPU wheel index.
- [x] Python: 3.13 (dev venv 3.13.9; wheels exist for all pins).
- [x] Data slice: 1.7 GB, exact files in `tools/stage_runtime_data.sh`.
- [x] Model id: `google/siglip2-base-patch16-384`; index/adapter/onnx paths confirmed.
- [x] Artifacts: `filesystem` mode → no GCP dependency (default in compose).
- [x] Env vars: full set mirrored from `.env.production` into `stack.env.example`.
- [ ] YOU: fill secrets in `stack.env`, stage+upload `data/`, then `docker compose up`.
- [ ] Optional: `litestream.yml` (see `litestream.example.yml`) for DB replication.

## Not-yet-wired (deliberate)
- **Deploy scripts** (`deploy_to_vm.sh`) stay GCP/venv-based — unaffected by these files.
  Switching prod to the container is a separate step; keep the staging/prod split +
  `SPOTLIGHT_PROD_CONFIRM` gate.
- **DB path**: prod runs the SQLite at `/tmp`; the container uses the persistent volume
  (`/app/backend/data/…`) instead (set in compose).
