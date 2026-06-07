#!/usr/bin/env python3
"""Rebuild the 204-row show-holdout fixture (holdout_all.json) for the backbone
bake-off, from the surviving labeled dataset + local catalog.

Originally this fixture lived only in /tmp/dimfoil/holdout_all.json and was lost on
a reboot. This regenerates it deterministically from durable inputs:
  - per-dir truth.json  (cardName / collectorNumber / setCode)
  - _truthmap_entries.json  (truthKey -> providerCardId)
  - cards table in spotlight_scanner.sqlite  (providerCardId -> rarity)
  - brightness = mean of the grayscale runtime_normalized.jpg

Validated against the original printed stats: 204 rows, foil=142, dim-foil(b<130)=55.
This reconstruction reproduces 204 rows / exact truthIds / exact brightness / foil=142;
dim-foil comes out 56 (one card's isFoil label differs). The bake-off's headline
top-1/5/10 over the full 204 depends only on dir+truthId+image, so it is unaffected.
"""
import json, os, sqlite3
import numpy as np
from PIL import Image

REPO = "/Users/stephenchan/Code/spotlight"
HOLD = os.path.expanduser("~/spotlight-datasets/raw-visual-expansion-holdouts/labeled-20260519-20260604")
CATALOG_DB = f"{REPO}/backend/data/spotlight_scanner.sqlite"
OUT = f"{REPO}/tools/backbone_bakeoff/holdout_all.json"

# non-foil rarities (everything else with a known rarity is treated as foil).
# Tuned to reproduce the original foil=142 count.
NON_FOIL = {"Common", "Uncommon", "Rare", "Unknown"}

key2pid = {e["truthKey"]: e["providerCardId"]
           for e in json.load(open(f"{HOLD}/_truthmap_entries.json"))["entries"]}
con = sqlite3.connect(CATALOG_DB)
rarity_of = {r[0]: r[1] for r in con.execute("select id, rarity from cards")}
con.close()

rows = []
for d in sorted(os.listdir(HOLD)):
    dpath = os.path.join(HOLD, d)
    tj = os.path.join(dpath, "truth.json")
    img = os.path.join(dpath, "runtime_normalized.jpg")
    if not os.path.isdir(dpath) or not os.path.exists(tj):
        continue
    t = json.load(open(tj))
    pid = key2pid.get(f'{t["cardName"]}|{t["collectorNumber"]}|{t["setCode"]}')
    rarity = rarity_of.get(pid)
    brightness = (round(float(np.asarray(Image.open(img).convert("L")).mean()), 1)
                  if os.path.exists(img) else 0.0)
    is_foil = rarity is not None and rarity not in NON_FOIL
    rows.append(dict(dir=d, truthId=pid, collectorNumber=t["collectorNumber"],
                     setCode=t["setCode"], cardName=t["cardName"],
                     brightness=brightness, rarity=rarity, isFoil=is_foil))

json.dump(rows, open(OUT, "w"), indent=2, ensure_ascii=False)

foil = [r for r in rows if r["isFoil"]]
dim = [r for r in foil if r["brightness"] < 130]
miss_pid = [r for r in rows if r["truthId"] is None]
print(f"wrote {OUT}")
print(f"rows={len(rows)}  foil={len(foil)}  dim-foil(b<130)={len(dim)}  missing-truthId={len(miss_pid)}")
print(f"expected: rows=204  foil=142  dim-foil=55(orig)  missing-truthId=0")
