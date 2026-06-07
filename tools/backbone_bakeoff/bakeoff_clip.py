#!/usr/bin/env python3
"""Patched re-run of ONLY the get_image_features arms (CLIP B/16, L/14, SigLIP2)
that failed under transformers 5.x (get_image_features now returns a ModelOutput).
Reads existing /tmp/backbone_exp/results.json, appends these arms, reprints table."""
import os, sys, json, time, gc
import numpy as np
from pathlib import Path
import torch
from PIL import Image
REPO = "/Users/stephenchan/Code/spotlight"
for p in (f"{REPO}/tools", f"{REPO}/backend"):
    if p not in sys.path: sys.path.insert(0, p)
from raw_visual_model import resolve_torch_device
VI = f"{REPO}/backend/data/visual-index"
HOLD = os.path.expanduser("~/spotlight-datasets/raw-visual-expansion-holdouts/labeled-20260519-20260604")
# Durable paths (NOT /tmp — wiped on reboot). Must match bakeoff.py so caches are shared.
HOLDOUT_JSON = f"{REPO}/tools/backbone_bakeoff/holdout_all.json"
OUT = os.path.expanduser("~/spotlight-datasets/backbone-bakeoff"); os.makedirs(OUT, exist_ok=True)
torch_dev = resolve_torch_device("mps")

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

def embed_hf(model_id, paths, cache, batch=64):
    if os.path.exists(cache):
        print(f"  [cache] {cache}", flush=True); return np.load(cache)
    from transformers import AutoModel, AutoImageProcessor, AutoProcessor
    try: proc = AutoImageProcessor.from_pretrained(model_id)
    except Exception: proc = AutoProcessor.from_pretrained(model_id)
    model = AutoModel.from_pretrained(model_id).to(torch_dev).eval()
    has_gif = hasattr(model, "get_image_features")
    embs, t0 = [], time.time()
    with torch.no_grad():
        for i in range(0, len(paths), batch):
            imgs = load_imgs(paths[i:i+batch])
            inp = proc(images=imgs, return_tensors="pt").to(torch_dev)
            raw = model.get_image_features(**inp) if has_gif else model(**inp)
            f = to_tensor(raw)
            embs.append(f.float().cpu().numpy())
            if (i // batch) % 50 == 0:
                print(f"    {model_id}: {i+len(imgs)}/{len(paths)}  {time.time()-t0:.0f}s", flush=True)
    del model; gc.collect()
    if torch_dev.type == "mps": torch.mps.empty_cache()
    arr = l2(np.concatenate(embs).astype(np.float32)); np.save(cache, arr); return arr

def topk_eval(gal, qry, k=10):
    t1=t5=t10=0; h1=[]; h10=[]
    for i in range(qry.shape[0]):
        sims = gal @ qry[i]
        idx = np.argpartition(-sims, k)[:k]; idx = idx[np.argsort(-sims[idx])]
        ids = [ROW_IDS[j] for j in idx]
        a = ids[0]==TRUTHS[i]; b5 = TRUTHS[i] in ids[:5]; c = TRUTHS[i] in ids
        t1+=a; t5+=b5; t10+=c; h1.append(a); h10.append(c)
    return t1,t5,t10,h1,h10

results = json.load(open(f"{OUT}/results.json")) if os.path.exists(f"{OUT}/results.json") else []
have = {r["name"] for r in results}
slug = lambda s: s.replace("/","_").replace(" ","_")
ARMS = [("clip-b16 zeroshot","openai/clip-vit-base-patch16"),
        ("clip-l14 zeroshot","openai/clip-vit-large-patch14"),
        ("siglip2-b16 zeroshot","google/siglip2-base-patch16-224")]
for name, mid in ARMS:
    if name in have: print(f"skip {name} (already in results)", flush=True); continue
    print(f"\n== arm: {name}  ({mid}) ==", flush=True)
    try:
        gal = embed_hf(mid, REF_PATHS, f"{OUT}/gal_{slug(mid)}.npy")
        qry = embed_hf(mid, QPATHS, f"{OUT}/qry_{slug(mid)}.npy")
        t1,t5,t10,h1,h10 = topk_eval(gal, qry)
        df1=sum(h1[i] for i in DIMFOIL); df10=sum(h10[i] for i in DIMFOIL)
        f1=sum(h1[i] for i in FOIL); f10=sum(h10[i] for i in FOIL)
        results.append(dict(name=name,dim=gal.shape[1],t1=t1,t5=t5,t10=t10,df1=df1,df10=df10,
                            nd=len(DIMFOIL),f1=f1,f10=f10,nf=len(FOIL)))
        json.dump(results, open(f"{OUT}/results.json","w"), indent=2)
        print(f"  >> {name:22} t1={t1}/{N} ({100*t1//N}%)  t10={t10} ({100*t10//N}%)  "
              f"| dim-foil t1={df1}/{len(DIMFOIL)} t10={df10}", flush=True)
        del gal, qry; gc.collect()
    except Exception as e:
        print(f"  !! {name} FAILED: {type(e).__name__}: {e}", flush=True)

ORDER = ["v011 (B32+adapter)","clip-b32 zeroshot","clip-b16 zeroshot","clip-l14 zeroshot",
         "dinov2-b14 zeroshot","dinov2-l14 zeroshot","siglip2-b16 zeroshot"]
results.sort(key=lambda r: ORDER.index(r["name"]) if r["name"] in ORDER else 99)
print("\n\n========= FINAL backbone bake-off (show holdout N=%d, 43,982-card gallery) =========" % N, flush=True)
hdr = f"{'arm':24}{'dim':>5}{'top1':>11}{'top5':>11}{'top10':>11}{'dimfoil-t1':>12}{'dimfoil-t10':>12}"
print(hdr, flush=True)
for r in results:
    c1=f"{r['t1']} ({100*r['t1']//N}%)"; c5=f"{r.get('t5','-')}"
    c5=f"{r['t5']} ({100*r['t5']//N}%)" if 't5' in r else "-"
    c10=f"{r['t10']} ({100*r['t10']//N}%)"; cd1=f"{r['df1']}/{r['nd']}"; cd10=f"{r['df10']}/{r['nd']}"
    print(f"{r['name']:24}{r['dim']:>5}{c1:>11}{c5:>11}{c10:>11}{cd1:>12}{cd10:>12}", flush=True)
print("\nALLDONE", flush=True)
