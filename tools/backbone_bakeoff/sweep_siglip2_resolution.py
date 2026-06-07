#!/usr/bin/env python3
"""EXPERIMENT ONLY — SigLIP2 input-resolution sweep.

We won the backbone bake-off with the SMALLEST SigLIP2 (patch16-224, 58% zero-shot ->
69% trained). This asks: do the higher-resolution variants read tiny card detail (set
symbols, collector numbers) better, and what does it cost in latency? Cards are tall
(630x880) and 224x224 squishes them square, so naflex (native aspect ratio) is included.

For each variant: zero-shot embed the full 43,982-card gallery + 204 show-holdout queries,
score top-1/5/10 + dim-foil on the show holdout (same methodology as the bake-off, directly
comparable to 224 zero-shot 58/75/77, trained 69/85/86, and v011 48/69/73), and measure
batch=1 CPU forward latency (the runtime is a CPU VM). Per-variant try/except so a bad
checkpoint (e.g. naflex's different input format) can't kill the run. Caches to durable
storage; nothing ships.
"""
import os, sys, json, time, gc
import numpy as np
import torch
from PIL import Image

REPO = "/Users/stephenchan/Code/spotlight"
VI = f"{REPO}/backend/data/visual-index"
HOLD = os.path.expanduser("~/spotlight-datasets/raw-visual-expansion-holdouts/labeled-20260519-20260604")
OUT = os.path.expanduser("~/spotlight-datasets/backbone-bakeoff"); os.makedirs(OUT, exist_ok=True)
HOLDOUT_JSON = f"{REPO}/tools/backbone_bakeoff/holdout_all.json"
MPS = torch.device("mps")
CPU = torch.device("cpu")

# 224 is already measured (zero-shot 58/75/77). Sweep the rest.
VARIANTS = [
    ("siglip2-256",    "google/siglip2-base-patch16-256",    64),
    ("siglip2-384",    "google/siglip2-base-patch16-384",    32),
    ("siglip2-512",    "google/siglip2-base-patch16-512",    16),
    ("siglip2-naflex", "google/siglip2-base-patch16-naflex", 32),
]

man = json.load(open(f"{VI}/visual_index_active_manifest.json"))
ents = man["entries"] if isinstance(man, dict) and "entries" in man else man
ROW_IDS = [str(e["providerCardId"]) for e in ents]
REF_PATHS = [e["referenceImagePath"] for e in ents]
hold = json.load(open(HOLDOUT_JSON))
QPATHS = [f"{HOLD}/{r['dir']}/runtime_normalized.jpg" for r in hold]
TRUTHS = [r["truthId"] for r in hold]
DIMFOIL = [i for i, r in enumerate(hold) if r["isFoil"] and r["brightness"] < 130]
FOIL = [i for i, r in enumerate(hold) if r["isFoil"]]
N = len(hold)
print(f"gallery={len(ROW_IDS)}  queries={N}  dim-foil={len(DIMFOIL)}  threads={torch.get_num_threads()}", flush=True)


def l2(x):
    n = np.linalg.norm(x, axis=1, keepdims=True); n[n == 0] = 1; return x / n

def load_imgs(paths):
    out = []
    for p in paths:
        try: out.append(Image.open(p).convert("RGB"))
        except Exception: out.append(Image.new("RGB", (224, 224), (127, 127, 127)))
    return out

def to_tensor(f):
    if torch.is_tensor(f): return f
    for a in ("image_embeds", "pooler_output", "last_hidden_state"):
        v = getattr(f, a, None)
        if v is not None:
            return v[:, 0] if (a == "last_hidden_state" and v.dim() == 3) else v
    raise TypeError(f"cannot extract embedding from {type(f)}")

def embed(model, proc, paths, cache, batch, dev):
    if os.path.exists(cache):
        print(f"    [cache] {os.path.basename(cache)}", flush=True); return np.load(cache)
    embs, t0 = [], time.time()
    with torch.no_grad():
        for i in range(0, len(paths), batch):
            inp = proc(images=load_imgs(paths[i:i+batch]), return_tensors="pt").to(dev)
            embs.append(to_tensor(model.get_image_features(**inp)).float().cpu().numpy())
            if (i // batch) % 50 == 0:
                print(f"      {os.path.basename(cache)}: {i+batch}/{len(paths)}  {time.time()-t0:.0f}s", flush=True)
    arr = l2(np.concatenate(embs).astype(np.float32)); np.save(cache, arr); return arr

def cpu_latency_ms(model, proc, sample_paths, n=20):
    """Batch=1 CPU forward latency, warmed up, median. Same threading as the 224=49ms reading."""
    model_cpu = model.to(CPU)
    imgs = load_imgs(sample_paths[:n])
    with torch.no_grad():
        warm = proc(images=[imgs[0]], return_tensors="pt").to(CPU); model_cpu.get_image_features(**warm)
        ts = []
        for im in imgs:
            t0 = time.time()
            inp = proc(images=[im], return_tensors="pt").to(CPU)
            model_cpu.get_image_features(**inp)
            ts.append((time.time() - t0) * 1000)
    ts.sort()
    return ts[len(ts)//2]

def score(gal, qry):
    t1 = t5 = t10 = d1 = d10 = 0
    for i in range(N):
        s = gal @ qry[i]; idx = np.argpartition(-s, 10)[:10]; idx = idx[np.argsort(-s[idx])]
        ids = [ROW_IDS[j] for j in idx]
        a = ids[0] == TRUTHS[i]; b5 = TRUTHS[i] in ids[:5]; c = TRUTHS[i] in ids
        t1 += a; t5 += b5; t10 += c
        if i in DIMFOIL: d1 += a; d10 += c
    return dict(t1=t1, t5=t5, t10=t10, d1=d1, d10=d10)

results = []
slug = lambda mid: mid.replace("/", "_")
for name, mid, batch in VARIANTS:
    print(f"\n== {name}  ({mid}) ==", flush=True)
    try:
        from transformers import AutoModel, AutoImageProcessor, AutoProcessor
        try: proc = AutoImageProcessor.from_pretrained(mid)
        except Exception: proc = AutoProcessor.from_pretrained(mid)
        model = AutoModel.from_pretrained(mid).to(MPS).eval()
        gal = embed(model, proc, REF_PATHS, f"{OUT}/gal_{slug(mid)}.npy", batch, MPS)
        qry = embed(model, proc, QPATHS, f"{OUT}/qry_{slug(mid)}.npy", batch, MPS)
        lat = cpu_latency_ms(model, proc, QPATHS)
        sc = score(gal, qry)
        sc.update(name=name, dim=gal.shape[1], cpu_ms=round(lat, 1))
        results.append(sc)
        print(f"  >> {name:16} top1={sc['t1']}/{N} ({100*sc['t1']//N}%)  top5={sc['t5']} ({100*sc['t5']//N}%)  "
              f"top10={sc['t10']} ({100*sc['t10']//N}%)  | dim-foil t1={sc['d1']}/{len(DIMFOIL)} t10={sc['d10']}  "
              f"| dim={sc['dim']}  cpu={sc['cpu_ms']}ms", flush=True)
        json.dump(results, open(f"{OUT}/siglip2_resolution_sweep.json", "w"), indent=2)
        del model, gal, qry; gc.collect(); torch.mps.empty_cache()
    except Exception as e:
        import traceback
        print(f"  !! {name} FAILED: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()

print("\n\n========= SigLIP2 resolution sweep — show holdout (N=%d, 43,982 gallery) =========" % N, flush=True)
print(f"{'variant':18}{'dim':>5}{'top1':>11}{'top5':>11}{'top10':>11}{'dimfoil-t1':>12}{'cpu(b=1)':>11}", flush=True)
print(f"{'siglip2-224 (base)':18}{768:>5}{'119 (58%)':>11}{'154 (75%)':>11}{'158 (77%)':>11}{'30/56':>12}{'49ms':>11}", flush=True)
for r in results:
    c1 = f"{r['t1']} ({100*r['t1']//N}%)"; c5 = f"{r['t5']} ({100*r['t5']//N}%)"; c10 = f"{r['t10']} ({100*r['t10']//N}%)"
    cd1 = f"{r['d1']}/{len(DIMFOIL)}"; cms = f"{r['cpu_ms']}ms"
    print(f"{r['name']:18}{r['dim']:>5}{c1:>11}{c5:>11}{c10:>11}{cd1:>12}{cms:>11}", flush=True)
print("\n  reference: siglip2-224 TRAINED=69/85/86 | v011 (live) 48/69/73", flush=True)
print("\nALLDONE", flush=True)
