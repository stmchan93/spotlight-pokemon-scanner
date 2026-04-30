# Scanner + Model Rewrite Spec

Date: 2026-04-23

## Status

- This document is the forward-looking source of truth for the scanner and raw visual retrieval rewrite covering the 2026-Q2+ window.
- It supersedes earlier scanner guidance where they conflict. Earlier docs remain for historical context:
  - [raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md)
  - [raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md)
  - [ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md)
  - [react-native-parallel-execution-spec-2026-04-21.md](/Users/stephenchan/Code/spotlight/docs/react-native-parallel-execution-spec-2026-04-21.md)
- This spec is paired with the data loop spec:
  - [scan-data-labeling-pipeline-spec-2026-04-23.md](/Users/stephenchan/Code/spotlight/docs/scan-data-labeling-pipeline-spec-2026-04-23.md)

## Priority Order (Strict)

1. Top-1 accuracy
2. Top-10 contains-truth
3. Latency
4. Long-term maintainability across iOS + React Native + future OCR-optional path

If a proposed change improves top-10 at the cost of top-1, reject it unless it is a clearly scoped interim step with a follow-up that recovers top-1.

## Current State As Of 2026-04-28

### Active runtime model

- `raw_visual_runtime_active.json` says `artifactVersion = v009-scrydex-cardphotos259-sweep-selected`, published `2026-04-28T20:11:59Z`.
- `raw_visual_adapter_active.pt` and `visual_index_active_*.npz` bytes confirm this — they are identical to the `v009-scrydex-cardphotos259-sweep-selected_*` source files.
- v009-sweep-selected is trained on the `cardphotos259` corpus and replaces the previous `v006-scrydex-cardphotos33-clean` active alias.
- A fresh pre-v009 backup exists under `backend/data/visual-models/active-backups/` and `backend/data/visual-index/active-backups/`.

### Corpus ceiling

- The previous `v006-scrydex-cardphotos33-clean` adapter was trained on ~33 unique cards (manifest had 388 records, 89 providers, but the corpus-name suffix `-cardphotos33` records the small unique-card root count).
- The active v009 adapter was trained on the 259-card corpus.
- Training-corpus size, not backbone capacity, is now the primary ceiling for visual retrieval quality.

### Scanner front half

- `CameraSessionController.swift:41,344`: zoom fixed at `1.5×`.
- `ScannerReticleLayout.swift:34–69`: reticle aspect `88:63`, sized from container.
- `CameraSessionController.swift:196–208, 539`: expanded search crop is `1.45×` reticle area.
- `TargetSelection.swift`: rectangle detection min confidence `0.20`, min area `0.10`, selection threshold `0.62` for raw, fallback capped at `0.58` with `0.18` penalty.
- `PerspectiveNormalization.swift:5`: canonical canvas is `630×880` px, black-letterboxed.
- Fallback branch and rectangle branch produce differently-framed normalized crops, which is the primary scan-to-scan inconsistency source.
- React Native scanner is no longer just a placeholder. `apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx` uses `expo-camera`, the app reticle, and `buildNormalizedScannerTarget` for a `630×880` normalized target. This is the current RN scanner surface to reuse for guided labeling sessions.
- React Native labeling sessions exist, but currently use a separate capped preview frame in `apps/spotlight-rn/src/features/labeling/screens/labeling-session-screen.tsx`. That is a data-quality mismatch: guided labeling should use the same scanner surface and reticle geometry as normal scan mode.

### Backend retrieval

- `/api/v1/scan/visual-match` returns a provisional top-10 within ~50–150 ms.
- `/api/v1/scan/rerank` applies OCR-weighted reranking; hybrid weights dynamically `0.70–0.88` visual, `0.12–0.30` OCR; leader protection, language-mismatch dampening, and local-OCR rescue caps all exist (`catalog_tools.py:4399–4613`).
- `/api/v1/scan-artifacts` exists and writes both `source_capture` and `normalized_target` to filesystem or GCS with `scan_artifacts` row.
- Frozen CLIP ViT-B/32 + single 512→512 linear adapter, identity-initialized. No backbone unfreezing.
- Schema already has: `scan_events`, `scan_artifacts`, `scan_prediction_candidates`, `scan_price_observations`, `scan_confirmations`, `deck_entries` — with `predicted_card_id`, `selected_card_id`, `confirmed_card_id` cleanly separated.

### Gaps

1. No tier-safe connector from backend confirmed scans → training/eval corpus. Training currently still depends on manual or semi-manual batch export/import.
2. OCR rerank is not gated on OCR confidence; rerank runs whenever a visual response exists.
3. `scan_events`, `scan_artifacts`, and `scan_confirmations` now carry `owner_user_id`, but the data-loop docs/tools still need to converge on that naming and ensure every scan/labeling write path stamps it.
4. No explicit pixels-per-card-height metric is logged from the iOS front half. Camera zoom factor is persisted per scan but effective card resolution is not derived.
5. No "consistency@same-card" metric anywhere. The closest we have is per-fixture replay, not repeated live captures of the same physical card.
6. React Native scanner is functional for the current Expo path, but it is not yet extracted into a shared capture surface for normal scan and labeling session capture.
7. `scan_prediction_candidates` stores the top-K but the app's scan-review tray does not yet feed a manual-label queue that updates the training pipeline.
8. `labeling_sessions` / `labeling_session_artifacts` are landed, but the backend does not yet route completed sessions to Tier 2/Tier 3, does not stamp `provider_card_id` / `tier_assignment`, and does not link each angle to a normal `scan_event`.
9. `tools/process_raw_visual_batch.py` currently performs image-level expansion holdout selection. Product model-release data must use provider-card-level tier routing so one card's angles cannot be split across train and eval.

## Target Architecture

The scanner has four layers. Treat them as independently testable.

### Layer A: Capture (platform-specific)

Responsibility: produce a `raw_preview_frame` with consistent pixels-per-card-height given a known reticle geometry.

iOS today (Swift):
- `CameraSessionController` + `ScannerReticleLayout`.

RN future (Phase 4–5):
- Recommended library: `react-native-vision-camera` with frame processors. Rationale: only RN library with a stable synchronous frame-processor contract, production maturity, and access to native `CMSampleBuffer` / `CameraX` frames. `expo-camera` does not expose frames at the needed cadence.
- Contract: the frame processor returns the same `raw_preview_frame` shape the iOS scanner produces today, plus capture metadata (`zoom`, `device_id`, `capture_ts`).

Shared invariant: card must occupy `≥ 70%` of reticle height on every capture. This is the Layer A health metric.

### Layer B: Normalization (platform-specific, shared spec)

Responsibility: turn `raw_preview_frame` + reticle geometry into a `normalized_target` crop.

Shared spec:
- If rectangle detection returns a candidate with score `≥ 0.62` **and** margin-to-runner-up `≥ 0.05`: perspective-correct + canonicalize to `630×880`, letterboxed.
- Else: exact reticle crop, canonicalize to `630×880`. Tag `fallback_source = "exact_reticle"`.
- Always emit `normalized_target_metadata`:
  - `source_branch`: `"rectangle"` or `"exact_reticle"`
  - `rectangle_confidence`
  - `corners_normalized`
  - `pixels_per_card_height` (derived from the pre-canonicalization card bounding box)
  - `processing_ms`

iOS today: `TargetSelection.swift` + `PerspectiveNormalization.swift`. Add explicit `pixels_per_card_height` derivation (currently not logged).

RN future: port the same spec. Start by bridging the Swift normalization modules through a native module interface; port to Kotlin in Phase 5.

### Layer C: Retrieval (backend, shared)

Responsibility: take `normalized_target` and return candidate top-K with hybrid scoring.

Keep:
- `/api/v1/scan/visual-match` → top-10 visual-only, fast.
- `/api/v1/scan/rerank` → OCR-weighted rerank.
- Frozen CLIP ViT-B/32 + learned adapter for now. Revisit backbone unfreezing only after corpus size crosses 500 unique cards.

Change:
- **Gate rerank on OCR confidence.** If the OCR footer confidence is below a threshold (target `0.55`), skip rerank and return the visual top-10 as-is. OCR noise should not be able to reorder a clean visual top-1. This is specifically to stop "same card flips between scans" when OCR flickers.
- **Log which branch fed rerank.** Add `rerank_source` = `"ocr_confident"` | `"visual_only"` | `"leader_protected"` on every response.
- **Persist which artifact version served the response.** Add `matcher_version` on every response row in `scan_events` (already exists as a column; ensure it is always populated with the runtime `artifactVersion` from `raw_visual_runtime_active.json`).

### Layer D: Presentation + Confirmation (shared)

Responsibility: show the user top candidates, let them confirm, treat confirmation as a trusted label.

Keep:
- Top-5 card tray already returns from backend.
- `Add to deck` already writes `scan_confirmations` and stamps `confirmed_card_id` on `scan_events`.

Change:
- After the scan tray shows top-10, every alternate selection the user taps should write `selected_card_id` and `selected_rank` on the scan immediately (today it happens only at deck add). This is the key to the data loop: alternate-pick = free label.
- A new friend-labeling UI reuses the scan review tray to let a trusted reviewer label other users' scans. Details in the data pipeline spec.

## OCR: Present and Future

### Today

OCR is secondary evidence. This does not change.

### Mid-term (next two training cycles)

Gate rerank on OCR confidence. Let OCR abstain when footer text is unreadable. This reduces "same-card flips between scans" caused by OCR noise.

### Long-term (ideal)

The long-term goal is to make OCR removable. The right gate to trigger that is empirical:

- Visual top-1 on the mixed runtime suite `≥ 90%`
- Visual top-5 contains-truth `≥ 98%`
- OCR-rerank-off vs OCR-rerank-on shows no top-1 regression on the same suite

Until all three are met, keep OCR rerank in place. When all three are met, delete OCR from the raw path, keep it only for slab (which is cert-first anyway). This path is realistic only after the training corpus crosses ~500 unique cards and hard-negative mining has iterated 3+ cycles against reprint clusters.

This removes the need to rebuild OCR for React Native at all — a strong architectural win for long-term maintainability.

## Implementation Phases

Each phase has entry prerequisites, exit gates, and no-regressions guardrails. Do not skip phases.

### Phase 1: Instrumentation + deployment truth (Week 1)

Entry: none.

Work:
1. Keep the active alias documented against `raw_visual_runtime_active.json`; as of 2026-04-28 this is `v009-scrydex-cardphotos259-sweep-selected`.
2. Add `matcher_version` stamping to every raw scan response. Surface it in the scan-review tray in Debug builds so it's visible to the friend tester.
3. Log `pixels_per_card_height` in `scan_artifacts`. Add it to the `scan_artifacts` table via migration.
4. Log `rerank_source` on every scan response.
5. Add end-to-end stage timing to `scan_events.response_json` with a fixed schema:
   - `capture_ms`, `target_selection_ms`, `ocr_ms`, `upload_ms`, `visual_match_ms`, `rerank_ms`, `total_ms`.
6. Update `spotlight-scanner-master-status-2026-04-03.md` to reflect the actual active alias.

Exit gate:
- Running 20 live scans produces rows in `scan_events` with complete stage timing, `matcher_version`, `rerank_source`, and `pixels_per_card_height`.
- Friend-cohort build surfaces the active artifact version in the scan tray.

No regressions:
- Top-1 on frozen legacy suite (`qa/raw-footer-layout-check/`) does not drop.

### Phase 2: Front-half fixes (Week 2)

Entry: Phase 1 complete.

Work:
1. Re-measure `pixels_per_card_height` distribution on a fresh 50-scan corpus. If median is below a baseline threshold (we'll set the threshold empirically after first measurement; as a starting point, require `normalized_target` card content to fill `≥ 80%` of the `630×880` canvas), bump camera zoom from `1.5×` to `2.0×` and re-measure.
2. Add temporal stability to rectangle detection. Require two consecutive preview frames agreeing on the rectangle corners within `10 px` before committing to the "rectangle" branch. Otherwise wait or fall through to exact reticle.
3. Gate OCR rerank on OCR confidence (`≥ 0.55`).
4. Add a debug overlay in Debug builds that shows `branch`, `rectangle_confidence`, `pixels_per_card_height`, and `rerank_source` after each scan.

Exit gate:
- Rectangle-vs-fallback branch ratio stable (±10%) across 30 test scans of the same 5 cards.
- `pixels_per_card_height` median meets the target threshold.
- Top-1 on frozen legacy suite does not regress.

No regressions:
- Latency does not rise by more than `300 ms` median.

### Phase 3: Data loop (Week 3)

Entry: Phase 2 complete. See [scan-data-labeling-pipeline-spec-2026-04-23.md](/Users/stephenchan/Code/spotlight/docs/scan-data-labeling-pipeline-spec-2026-04-23.md) for details.

Work:
1. Normalize on `owner_user_id` across docs/tools/API payloads; do not introduce a parallel `user_id` naming path.
2. Extract the RN scanner capture surface so normal scan mode and guided labeling sessions use the same camera preview, reticle geometry, tap region, and `buildNormalizedScannerTarget` path.
3. Update the RN labeling session to prompt four required captures on that scanner surface: `front`, `tilt_left`, `tilt_right`, `tilt_forward`.
4. Build the friend-labeling surface: a "label this scan" tray that shows the top-10 and lets a reviewer pick the correct card or mark `unclear` / `not in top 10`.
5. Wire `selected_card_id` writes on alternate-pick in the normal scan flow, not just on inventory add.
6. Add a new `scan_labeling_reviews` table for friend-review labels that are not inventory/deck events.
7. Extend `labeling_sessions` with `labeler_user_id`, `provider_card_id`, `tier_assignment`, `routed_batch_id`, and `first_capture_scan_id`; link each labeling artifact to a normal `scan_event`.
8. Build provider-card-level `raw_scan_registry.json` v2 routing. Every trusted `providerCardId` is assigned once to Tier 2 or Tier 3 and never moves.
9. Build `tools/export_scan_training_rows.py` that joins `scan_events`, `scan_artifacts`, `scan_confirmations`, and `scan_labeling_reviews` into a CSV suitable for downstream training/eval import.
10. Update `tools/process_raw_visual_batch.py` or add a replacement product-data importer so confirmed scan exports route capture groups into Tier 2/Tier 3 without image-level train/eval splitting.

Exit gate:
- Exported CSV is importable into the dataset pipeline with `0` contamination into the `qa/raw-footer-layout-check/` frozen suite.
- 50 trusted capture groups from normal scan confirmations and labeling sessions produce routed Tier 2/Tier 3 artifacts.
- No `providerCardId` appears in both training and expansion holdout roots.

No regressions:
- Scan UX latency unchanged.

### Phase 4: Corpus expansion + retrain (Week 4–6)

Entry: Phase 3 complete.

Work:
1. Run the data loop with the friend for two weeks. Target: grow training corpus from 33 → 200 unique cards via friend-labeled scans.
2. Retrain the adapter on the expanded corpus, with hard-negative mining re-run after each corpus growth.
3. Evaluate on frozen legacy + expansion holdouts separately, per existing `eval_raw_visual_model.py`.
4. Publish a candidate only if:
   - Visual top-10 on legacy `≥` current published (today ≈ `32/47` on the 47-fixture subset).
   - Visual top-1 on legacy `≥` current `+ 2` fixtures OR visual top-10 improves `≥ +3` fixtures.
   - No regression on expansion holdouts.

Exit gate:
- New candidate adapter is either published to active (meeting the gates above), or a rejection record is written explaining why and what to try next.

No regressions:
- After promotion, run 20 live scans against the friend cohort and confirm scan-to-scan consistency (same card scanned 3 times gives the same top-1 `≥ 80%` of the time).

### Phase 5: React Native scanner bridge (Week 6–10, parallel with Phase 4)

Entry: Phase 1 complete.

Work:
1. Add `react-native-vision-camera` to `apps/spotlight-rn`.
2. Build a shared native-module boundary: `@spotlight/scanner-native`. iOS side calls into the existing Swift `TargetSelection` + `PerspectiveNormalization`. Android side is Kotlin-only in Phase 5; defer it if Phase 4 is behind.
3. In JS: implement the scan flow using `packages/api-client` to call `/api/v1/scan/visual-match` and `/api/v1/scan/rerank` with the same contract the Swift app uses.
4. Match the iOS reticle UI from `packages/design-system`.
5. Port the scan review tray to RN, including the friend-labeling surface.

Exit gate:
- RN scanner produces a correct top-1 on a curated 20-card in-person test, at parity with iOS (±5%).
- Same artifact uploads land in the same backend tables; no RN-specific code path.

No regressions:
- iOS scanner keeps shipping unchanged.

### Phase 6: OCR removal evaluation (Week 12+)

Entry: Phase 4 hit the long-term OCR-removal gates, OR two full retrain cycles have happened.

Work:
1. Run A/B on the mixed runtime suite: OCR rerank on vs off.
2. If top-1 parity is met, delete OCR from the raw path. Keep slab OCR untouched.
3. Update the RN scanner to skip OCR entirely.

Exit gate:
- Raw runtime is OCR-free on iOS and RN.
- Latency drops by the OCR processing delta.

No regressions:
- Top-1 on frozen legacy suite does not drop. Hard requirement.

## Non-Goals

- Do not attempt a larger CLIP backbone (ViT-L/14, SigLIP) until Phase 4 has plateaued.
- Do not add artwork-only-crop training variants.
- Do not reintroduce holder salvage or remnant-recovery normalization branches.
- Do not add per-card OCR heuristics.
- Do not cross-contaminate `qa/raw-footer-layout-check/` into training for any reason.
- Do not rewrite the scanner in pure JS for the RN migration. Vision pipelines stay native.
- Do not broaden runtime `top-K` above 10 in this cycle.

## Validation Contract

Backend:
```bash
python3 -m py_compile backend/server.py backend/raw_visual_matcher.py backend/raw_visual_index.py backend/raw_visual_model.py backend/scan_artifact_store.py

python3 -m unittest -v \
  backend.tests.test_raw_evidence_phase3 \
  backend.tests.test_raw_retrieval_phase4 \
  backend.tests.test_raw_decision_phase5 \
  backend.tests.test_pricing_phase6 \
  backend.tests.test_scan_logging_phase7 \
  backend.tests.test_user_isolation
```

Visual-retrieval eval:
```bash
.venv-raw-visual-poc/bin/python tools/eval_raw_visual_model.py \
  --adapter-path backend/data/visual-models/raw_visual_adapter_active.pt \
  --fixture-root qa/raw-footer-layout-check \
  --suite legacy

.venv-raw-visual-poc/bin/python tools/eval_raw_visual_model.py \
  --adapter-path backend/data/visual-models/raw_visual_adapter_active.pt \
  --fixture-root ~/spotlight-datasets/raw-visual-expansion-holdouts \
  --suite expansion
```

App:
```bash
zsh tools/run_scanner_reticle_layout_tests.sh
zsh tools/run_scan_tray_logic_tests.sh

xcodebuild -project Spotlight.xcodeproj -scheme Spotlight \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build
```

## Decision Log Points

Every phase transition should record:
- Date
- Active `artifactVersion` before and after
- Evaluation deltas on legacy + expansion holdouts
- Any gate waivers and their justification

Write these to the bottom of this spec or a paired `scanner-model-rewrite-decision-log.md`. Do not let `PLAN.md` be the only home.

## Decisions Locked 2026-04-23

The three previously-open Phase 2 entry questions are resolved. See the data pipeline spec's "Decisions Locked 2026-04-23" section for the full list; the ones that affect this spec are:

1. **Friend-label UI lives in the scan review tray.** No separate `Label` tab, no web tool. RN should reuse the same scanner tray/candidate components used by normal scanning; Swift references are historical for the old native surface.
2. **Storage split by purpose, not by phase:**
   - Labeling-session captures (admin-gated `labeler` role, multi-angle per card) upload to GCS from day one. Layout: `gs://spotlight-labeling-sessions/<user_id>/<yyyy>/<mm>/<dd>/<labeling_session_id>/...`. These are treated as canonical labeled data and then routed to Tier 2 or Tier 3; we do not want to pay a migration cost later.
   - Regular (non-labeling-session) `scan_artifacts` follow the existing local-first path and migrate to GCS on the timeline in the data pipeline spec. This is a deliberate split — labeling sessions are the long-term artifact, normal scans are operational data.
3. **Phase 6 OCR removal is delete-with-git-history.** When the gates are met, remove OCR from the raw path outright. Do not keep the coordinator as dead-code rollback insurance. The git history is the rollback path.

Additional decisions from the same session, relevant to this spec:

4. **Labeling-session capture is admin-gated.** Users get a `labeler_enabled` flag, flipped only by the admin. The "Start labeling session" entry point is hidden in the scanner unless the flag is set. Normal scanning is unaffected.
5. **Multi-angle per card, single label per session.** A labeling session captures the required 4 angles of one physical card; the label is applied once and inherited by every angle. Friends never label per-angle.
6. **No train/eval split within a card.** Tier routing is by `providerCardId`. If a card is Tier 3, all trusted captures of that card are training-eligible. If a card is Tier 2, all trusted captures of that card are eval-only, including later normal scans.
7. **Tier 1/2/3 train/test discipline is the source of truth for split decisions.** See the data pipeline spec for the automated routing algorithm. This spec's eval gates in Phase 4 read from those tiers, not from ad-hoc folder contents.
8. **Target throughput is ~50 gold-labeled cards per friend per week.** Phase 4's corpus growth plan (33 → 200) assumes this pace.
