# Backbone bake-off (experiment only — nothing ships)

Re-embeds the full 43,982-card catalog gallery + 204 show-holdout queries through several
candidate encoders (zero-shot, no adapter) and compares retrieval top-1/5/10 against the
live v011 bar (CLIP B/32 + trained adapter). Apples-to-apples: same gallery, same queries,
each model uses its native processor.

## Files

- `bakeoff.py` — single-pass run of ALL arms (v011 bar, CLIP B/32 zero-shot, CLIP B/16,
  CLIP L/14, DINOv2-base, DINOv2-large, SigLIP2-base). Crash-recoverable: per-arm gallery/
  query embeddings are cached, so a re-run skips completed arms. Prints `DONE.` at the end.
- `bakeoff_clip.py` — legacy split-out of just the CLIP/SigLIP arms (kept as fallback; the
  `to_tensor` fix it carried is now folded into `bakeoff.py`, so normally unneeded).
- `build_holdout_fixture.py` — regenerates `holdout_all.json` from durable inputs.
- `holdout_all.json` — the 204-row eval fixture (dir / truthId / brightness / rarity / isFoil).

## Durable paths (lesson learned)

The original run wrote everything to `/tmp` and was lost on a reboot. Now:
- fixture lives in-repo at `tools/backbone_bakeoff/holdout_all.json`
- embedding caches + `results.json` go to `~/spotlight-datasets/backbone-bakeoff/`
  (outside `/tmp`, survives reboot; outside git, won't bloat the repo)

## Run

```bash
cd /Users/stephenchan/Code/spotlight
HF_HUB_DISABLE_PROGRESS_BARS=1 TOKENIZERS_PARALLELISM=false \
  backend/.venv/bin/python3 tools/backbone_bakeoff/bakeoff.py 2>&1 \
  | tee ~/spotlight-datasets/backbone-bakeoff/run.log
```

Re-running after an interruption resumes from the per-arm caches.

## Fixture validation

`holdout_all.json` reproduces the original stats: 204 rows, foil=142, truthIds + brightness
exact (Abomasnow=159.6). The v011 bar replays to **top-1 48% (98/204) / top-10 73% (150/204)**,
matching the known-good number. dim-foil count comes out 56 vs the original 55 (one card's
`isFoil` label differs); this only affects the dim-foil sub-metric, not the headline top-k.

## Known baselines (for reference while reading new numbers)

- v011 (B32 + trained adapter): top-1 48% / top-10 73%  ← the bar to beat
- CLIP B/32 zero-shot (no adapter): top-1 11% / top-10 26%  ← the +37pt training gap
