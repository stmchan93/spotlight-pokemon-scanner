#!/usr/bin/env python3
"""EXPERIMENT ONLY — train the raw-visual projection adapter on a SigLIP2 backbone (any
input resolution) and evaluate on the 204-card show holdout. Tests whether SigLIP2 + the
v011 adapter recipe beats live v011 (CLIP-B/32 + adapter, 48/69/73).

Usage:
    train_siglip2_adapter.py [RES ...]     # default: 224. e.g. `... 384 512`

Background: the backbone bake-off found SigLIP2-base ZERO-SHOT already beats trained v011,
and the resolution sweep found zero-shot 384 (69%) == trained-224 (69%). This trains the
adapter on top of the higher-res floors to find the real ceiling.

Design (faithful + low-risk): reuses the EXACT production training code by importing
tools/train_raw_visual_adapter.py and monkeypatching its encoder symbol with a SigLIP2 shim
(same interface). Same loss / augmentation / focus-batch sampling / hard negatives / early
stopping — only the backbone + resolution change. No runtime/backend code is modified.
Reuses the v011 training data verbatim. Base index for hard-neg refs + full-index validation
= the cached SigLIP2 gallery from the bake-off/sweep (43,982x768), wrapped into an .npz with
the active manifest (row-aligned). Final gate = the 204 show holdout, scored like the bake-off.
Nothing here ships.
"""
import os, sys, json
from pathlib import Path

import numpy as np
import torch
from PIL import Image

REPO = "/Users/stephenchan/Code/spotlight"
for p in (f"{REPO}/tools", f"{REPO}/backend"):
    if p not in sys.path:
        sys.path.insert(0, p)

DATASETS = os.path.expanduser("~/spotlight-datasets")
BAKE = f"{DATASETS}/backbone-bakeoff"
VI = f"{REPO}/backend/data/visual-index"
ACTIVE_MANIFEST = f"{VI}/visual_index_active_manifest.json"
HOLDOUT_JSON = f"{REPO}/tools/backbone_bakeoff/holdout_all.json"
HOLD = f"{DATASETS}/raw-visual-expansion-holdouts/labeled-20260519-20260604"

import train_raw_visual_adapter as T
from raw_visual_model import (load_projection_adapter, project_embeddings_numpy,
                              resolve_torch_device)

torch_dev = resolve_torch_device("mps")

# Zero-shot show-holdout baselines from the resolution sweep, for direct comparison.
ZEROSHOT = {
    "224": "58% / 75% / 77%", "256": "60% / 77% / 80%",
    "384": "69% / 84% / 86%", "512": "69% / 85% / 88%",
}


def _to_tensor(f):
    if torch.is_tensor(f):
        return f
    for a in ("image_embeds", "pooler_output", "last_hidden_state"):
        v = getattr(f, a, None)
        if v is not None:
            return v[:, 0] if (a == "last_hidden_state" and v.dim() == 3) else v
    raise TypeError(f"cannot extract embedding from {type(f)}")


def _l2(x):
    n = np.linalg.norm(x, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return (x / n).astype(np.float32)


class SigLipFrozenEncoder:
    """Same interface the trainer needs, mirroring the bake-off embed recipe EXACTLY so
    embeddings stay consistent with the cached gallery. model_id is passed per-variant."""
    def __init__(self, *, model_id, device="mps", **_ignored):
        from transformers import AutoModel, AutoImageProcessor, AutoProcessor
        self.model_id = model_id
        self.device = resolve_torch_device(device)
        try:
            self.processor = AutoImageProcessor.from_pretrained(model_id)
        except Exception:
            self.processor = AutoProcessor.from_pretrained(model_id)
        self.model = AutoModel.from_pretrained(model_id).to(self.device).eval()
        for param in self.model.parameters():
            param.requires_grad_(False)
        self.embedding_dim = 768

    def _embed_pil(self, images, batch_size):
        out = []
        with torch.no_grad():
            for i in range(0, len(images), batch_size):
                batch = [im.convert("RGB") if im.mode != "RGB" else im for im in images[i:i + batch_size]]
                inp = self.processor(images=batch, return_tensors="pt").to(self.device)
                f = _to_tensor(self.model.get_image_features(**inp))
                out.append(f.float().cpu().numpy())
        if not out:
            return np.zeros((0, self.embedding_dim), dtype=np.float32)
        return _l2(np.concatenate(out, axis=0))

    def embed_images(self, images, *, batch_size=32):
        return self._embed_pil(list(images), batch_size)

    def embed_image_paths(self, image_paths, *, batch_size=32):
        paths = [Path(p) for p in image_paths]
        if not paths:
            return np.zeros((0, self.embedding_dim), dtype=np.float32)
        imgs = []
        try:
            for p in paths:
                with Image.open(p) as im:
                    im.load()
                    imgs.append(im.convert("RGB"))
            return self._embed_pil(imgs, batch_size)
        finally:
            for im in imgs:
                try: im.close()
                except Exception: pass


def paths_for(res):
    mid = f"google/siglip2-base-patch16-{res}"
    return dict(
        res=res,
        model_id=mid,
        gallery=f"{BAKE}/gal_google_siglip2-base-patch16-{res}.npy",
        query=f"{BAKE}/qry_google_siglip2-base-patch16-{res}.npy",
        base_npz=f"{BAKE}/siglip2_{res}_base_index.npz",
        artifact_version=f"siglip2-{res}-v001-candidate",
        # higher res = larger MPS forward; shrink the per-epoch re-embed batch for 512.
        embed_batch="16" if int(res) >= 512 else "32",
    )


def build_base_npz(cfg):
    if os.path.exists(cfg["base_npz"]):
        print(f"[base] reuse {cfg['base_npz']}", flush=True)
        return
    g = np.load(cfg["gallery"]).astype(np.float32)
    man = json.load(open(ACTIVE_MANIFEST))
    ents = man["entries"] if isinstance(man, dict) and "entries" in man else man
    assert g.shape[0] == len(ents), f"gallery {g.shape} vs manifest {len(ents)} mismatch"
    np.savez_compressed(cfg["base_npz"], embeddings=g)
    print(f"[base] wrote {cfg['base_npz']}  {g.shape}", flush=True)


def run_training(cfg):
    build_base_npz(cfg)
    meta = json.load(open(f"{REPO}/backend/data/visual-models/raw_visual_adapter_active_metadata.json"))
    argv = [
        "train_raw_visual_adapter.py",
        "--manifest-path", meta["manifestPath"],
        "--hard-negatives-path", meta["hardNegativesPath"],
        "--scan-registry-path", meta["scanRegistryPath"],
        "--model-id", cfg["model_id"],
        "--artifact-version", cfg["artifact_version"],
        "--focus-batch-id", "labeled-20260519-20260604",
        "--focus-batch-provider-ratio", "0.30",
        "--index-npz", cfg["base_npz"],
        "--index-manifest", ACTIVE_MANIFEST,
        "--embedding-batch-size", cfg["embed_batch"],
        "--device", "mps",
        "--output-dir", "backend/data/visual-models",
    ]
    T.RawVisualFrozenEncoder = SigLipFrozenEncoder
    sys.argv = argv
    print(f"\n[train] {cfg['model_id']} (artifact={cfg['artifact_version']}, embed_batch={cfg['embed_batch']})", flush=True)
    T.main()


def evaluate_show_holdout(cfg):
    ckpt = Path(f"{REPO}/backend/data/visual-models/raw_visual_adapter_{cfg['artifact_version']}.pt")
    adapter = load_projection_adapter(ckpt, embedding_dim=768, device=torch_dev)
    man = json.load(open(ACTIVE_MANIFEST))
    ents = man["entries"] if isinstance(man, dict) and "entries" in man else man
    row_ids = [str(e["providerCardId"]) for e in ents]
    hold = json.load(open(HOLDOUT_JSON))
    truths = [r["truthId"] for r in hold]
    dim_idx = [i for i, r in enumerate(hold) if r["isFoil"] and r["brightness"] < 130]
    N = len(hold)
    gal = _l2(project_embeddings_numpy(adapter, np.load(cfg["gallery"]).astype(np.float32),
                                       device=torch_dev, batch_size=4096))
    qry = _l2(project_embeddings_numpy(adapter, np.load(cfg["query"]).astype(np.float32),
                                       device=torch_dev, batch_size=4096))
    t1 = t5 = t10 = d1 = d10 = 0
    for i in range(N):
        sims = gal @ qry[i]
        idx = np.argpartition(-sims, 10)[:10]
        idx = idx[np.argsort(-sims[idx])]
        ids = [row_ids[j] for j in idx]
        a = ids[0] == truths[i]; b5 = truths[i] in ids[:5]; c = truths[i] in ids
        t1 += a; t5 += b5; t10 += c
        if i in dim_idx: d1 += a; d10 += c
    nd = len(dim_idx)
    res = cfg["res"]
    print(f"\n==== SigLIP2-{res} + trained adapter — show holdout (N={N}) ====", flush=True)
    print(f"  trained:  top1={t1}/{N} ({100*t1//N}%)  top5={t5} ({100*t5//N}%)  top10={t10} ({100*t10//N}%)  "
          f"| dim-foil t1={d1}/{nd} t10={d10}/{nd}   [zero-shot was {ZEROSHOT.get(res,'?')}]", flush=True)
    result = dict(res=res, model_id=cfg["model_id"], t1=t1, t5=t5, t10=t10, d1=d1, d10=d10, nd=nd, N=N,
                  artifact=str(ckpt))
    json.dump(result, open(f"{BAKE}/siglip2_{res}_train_result.json", "w"), indent=2)
    return result


if __name__ == "__main__":
    resolutions = sys.argv[1:] or ["224"]
    summary = []
    for res in resolutions:
        cfg = paths_for(res)
        run_training(cfg)
        summary.append(evaluate_show_holdout(cfg))

    N = summary[0]["N"] if summary else 204
    print("\n\n========= SigLIP2 TRAINED resolution comparison — show holdout (N=%d) =========" % N, flush=True)
    print(f"{'variant':22}{'top1':>11}{'top5':>11}{'top10':>11}{'dimfoil-t1':>12}", flush=True)
    print(f"{'v011 (live, CLIP-B32)':22}{'98 (48%)':>11}{'142 (69%)':>11}{'150 (73%)':>11}{'27/56':>12}", flush=True)
    print(f"{'siglip2-224 trained':22}{'141 (69%)':>11}{'174 (85%)':>11}{'176 (86%)':>11}{'41/56':>12}", flush=True)
    for r in summary:
        c1 = f"{r['t1']} ({100*r['t1']//N}%)"; c5 = f"{r['t5']} ({100*r['t5']//N}%)"; c10 = f"{r['t10']} ({100*r['t10']//N}%)"
        cd1 = f"{r['d1']}/{r['nd']}"
        print(f"{'siglip2-'+r['res']+' trained':22}{c1:>11}{c5:>11}{c10:>11}{cd1:>12}", flush=True)
    print("\nALLDONE", flush=True)
