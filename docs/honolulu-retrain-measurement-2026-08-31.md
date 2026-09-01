# Honolulu-Label Retrain Measurement (v002 candidate)

Date: 2026-08-31
Status: **measured — DON'T SHIP yet; bank the corpus, triple the dose first**

## The question

Does labeling show scans improve the scanner? The user labeled the Honolulu show batch
(378 reviews → 329 confirmed labels across 275 cards) via the staging VM review site; this run
imported them, retrained, and measured honestly.

## Dose

- Corpus: 1,536 → **1,847 manifest rows** (+311; 272 Honolulu training + straggler recoveries)
- Tier firewall: 59 Honolulu scans reserved as a NEW frozen holdout
  (`~/spotlight-datasets/raw-visual-expansion-holdouts/show-2026-06-20-honolulu`), never trained on
- Hard negatives re-mined in SigLIP2 space (migration-plan step 1, finally executed):
  1,847 fixtures × 5, mined through the deployed adapter
- Trained `siglip2-384-v002-candidate` (MPS, focus batch = Honolulu @ 0.3, best epoch 3,
  val R@1 0.857/370). A longer-patience rerun (v002b) converged identically.

## Results

| benchmark | active v001 | v002 candidate | delta |
|---|---|---|---|
| **May show holdout (204, the gate)** | 162 (79%) / 187 / 189 | 164 (80%) / 183 / 186 | **+2 top-1 / −4 top-5 / −3 top-10** |
| **Fresh Honolulu holdout (57 scorable of 59)** | 46 (80.7%) / 53 / 55 | **49 (86.0%) / 54 / 55** | **+3 top-1 (+5.3pp) / +1 / =** |

Reading: 329 labels produced a **real but localized** gain — +5pp on the labeled show's own
distribution, a wash (within noise, with a small top-5 give-back) on the general gate. Consistent
with dose scaling: June's +10pt came from 1,035 labels.

## Verdict

- **Do not publish v002**: the gate requires beating the live numbers, and −4 top-5 fails it.
- **The labeling question is answered YES** — measurably, on-domain, at one-third the June dose.
- Next: label Pomona (314 to review; 162 pre-confirmed) + Ontario (596) → retrain v003 on the
  ~3× corpus → expect the general-gate jump. The pipeline below is now one command away.

## Pipeline notes (zero-Scrydex-credit recipe, reusable)

- VM reviews → local: dump `scan_labeling_reviews` rows, merge onto the export batch's
  `scan_review.csv` as `chosen_card_id` → `scan_review.final.csv`.
- `import_confirmed_scans_to_training.py --run-batch` (drop rows with empty collector number —
  one unnumbered JP promo killed the batch).
- **Manifest rebuild without Scrydex**: write `label_status.json` with a
  `providerMapping{providerCardId, …, sourceProvider:"scrydex"}` into each fixture dir (legacy
  from the old manifest's own rows; new from the batch TSV + catalog DB) — the builder's pinned
  path then needs zero API calls. 1,833 pinned + 101 stragglers via exact name+number match;
  19 remained unmapped (previously unmapped too).
- Mine: `mine_raw_visual_hard_negatives.py --model-id google/siglip2-base-patch16-384
  --adapter-checkpoint <active> --index-npz <bakeoff base npz> --index-manifest <pre-siglip2 bak>`.
- Gate trap (fixed in `eval_show_benchmark.py`): the borrowed CLIP-era manifest carries its own
  `adapterCheckpointPath`; the auto-detect now ignores projection markers whose manifest modelId
  differs from `--model-id` (trusting it silently cost 6 top-1).

## Artifacts

- `backend/data/visual-models/raw_visual_adapter_siglip2-384-v002-candidate.pt` (+ metadata/metrics/split)
- The imported corpus + new holdout persist; v003 training starts from `build_raw_visual_training_manifest.py` after the next batch import.

## UPDATE (same day): v003 with all three shows — PASSES THE GATE

User labeled Ontario (582) + Pomona (298) locally; total new-label dose ~1,209. Corpus 2,657
manifest rows; re-mined negatives; trained `siglip2-384-v003-candidate` (best epoch 2, val R@1 0.882).

| benchmark | active v001 | v003 | delta |
|---|---|---|---|
| May gate (204) | 162/187/189 | **171/192/195 (83%/94%/95%)** | +9/+5/+6 |
| Honolulu (57) | 46 | 47 | +1 |
| Ontario (132) | 115 | 120 | +5 |
| Pomona (82) | 66 | **78 (95%)** | +12 |

No regressions on any benchmark → **gate PASSED; recommend publishing** (staging first; prod in
the 1–8am PT dead window with explicit approval). Checkpoint:
`backend/data/visual-models/raw_visual_adapter_siglip2-384-v003-candidate.pt`. Publishing requires
rebuilding the projected runtime index with v003 (reference-image cache is local; ~1h MPS).

## SHIPPED (same day): v003 live on staging

Published via **adapter-composition reprojection** — staging's 46,118-row projected index was
transformed with M = W_v003 · W_v001⁻¹ (both adapters are bias-free 768×768 linears; parity
cos = 1.000000000 on 2,000 rows; the 204-gate reproduces 171/192/195 exactly through the
composition). This avoids a multi-hour re-embed and preserves the VM's incremental rows that
have no local base embeddings. Local active stack published the same way and re-verified.

Rollback (both places): restore `*.pre-v003-20260831.bak` (index npz, manifest, adapter) and
restart. Prod promotion: pending explicit approval, targeted at the 1–8am PT dead window.
