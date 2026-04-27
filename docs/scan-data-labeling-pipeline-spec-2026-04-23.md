# Scan Data + Labeling Pipeline Spec

Date: 2026-04-23

## Status

- This document is the source of truth for the scan → label → training-example data loop.
- Paired with [scanner-model-rewrite-spec-2026-04-23.md](/Users/stephenchan/Code/spotlight/docs/scanner-model-rewrite-spec-2026-04-23.md). This spec is the data pipeline half of that plan.
- Extends, not replaces, the existing local dataset workflow documented in [raw-visual-local-dataset-workflow-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-local-dataset-workflow-2026-04-12.md). The local-root + bucket layout stays. What this spec adds is the production ingestion side that feeds those roots.
- **Phase 2 decisions locked on 2026-04-23.** See "Decisions Locked 2026-04-23" section near the end for the canonical list of resolved questions. No further Phase 2 entry is blocked on open questions.

## Decisions Locked 2026-04-23

The following are no longer open — they are the source of truth for Phase 2 onward. Any change to these requires a new dated entry, not an edit-in-place.

1. **Labeling UI lives in-app.** The iOS scan review tray is the labeling surface. No web tool, no separate Label tab. Friends label from within the iOS app (and later RN) using the same top-10 list that already powers the scan tray. This is the "pick-one-of-ten" UX the user's original insight called for.
2. **Labeling sessions require an admin-granted role.** Not every authenticated user can label. There is a `labeler` role separate from `reviewer`. The admin (project maintainer) flips this role on per-user. See "Labeling Sessions (Admin Role)" section.
3. **Multi-angle per card is the default.** A labeling session captures multiple angles of one physical card; the label is applied once per session and inherited by all angles. Friend never labels individual angles.
4. **Labeling-session artifacts ship to GCS from day one.** Not local-filesystem-first. This is the mid/long-term design — we do not pay the migration cost twice. Regular (non-labeling-session) `scan_artifacts` may still use the existing local-first path and migrate later; labeling-session captures are treated as canonical training data and go straight to GCS.
5. **Target throughput is ~50 gold-labeled cards per week per friend.** Anything above that is welcome as long as the structured-capture rules in "Communication To Friends" are followed. This is the planning number, not a cap.
6. **Tier 1/2/3 train/test discipline is the source of truth.** See "Train/Test Split Discipline (Tier 1/2/3)" section. Tier membership is assigned automatically, not chosen manually, and is immutable once assigned.
7. **Automated tier routing.** When a labeling session closes, the backend routes captures into Tier 2 (expansion holdout) or Tier 3 (rolling training set) based on existing `raw_scan_registry.json` lookup. No human picks the tier. See "Automated Tier Routing".
8. **Friend-role reviewer sees names + images only; admin sees scores.** Friends should not anchor on model uncertainty.
9. **Opt-in to training is ON by default for friend-cohort / TestFlight builds, with no consent screen.** This is the friend cohort's understood baseline for the pilot. External store builds will re-evaluate this when the build exists.
10. **`scan_labeling_reviews` lives in the same SQLite as `scan_events`.** One DB until it causes a concrete performance problem.
11. **OCR removal cleanup is delete-with-git-history.** When Phase 6 gates are met, remove OCR code outright. Do not keep it as dead-code rollback insurance.

## Why This Exists

The ceiling on raw visual retrieval is training-corpus size. The current active adapter (`v006-scrydex-cardphotos33-clean`) was trained on ~33 unique cards because that's what a manual spreadsheet import can realistically produce.

Meanwhile, every real scan the app processes already produces:

- a `source_capture` image
- a `normalized_target` image
- a `top-10` candidate list
- user behavior (alternate picks, Add-to-deck, retries)

That is free labeled data. The only thing missing is the connector that turns it into training examples without contaminating evaluation.

The user's insight is the right one: **the existing top-10 is the labeling UI**. A reviewer does not have to type a card name — they pick a card from the list of 10 already shown, or mark `unclear`. This is fast, clicks-only labeling.

## Design Principles

1. **Confirmed labels are gold. Everything else is weak.** Confirmation means `Add-to-deck` by the scan owner, or a friend-reviewer explicit pick.
2. **Every persisted label is provenanced.** Who labeled it, at what time, how confident, against which model version.
3. **Contamination firewall is automated.** Any row tied to a `providerCardId` present in `qa/raw-footer-layout-check/` is blocked from `safe_training_augment` by the import tool, not by convention.
4. **Scans are private by default.** A friend reviewer sees only other friends' scans, and only in a reviewer role. Normal users never see each other's scans.
5. **Every row in the training manifest is traceable back to a `scan_id`.** If a model regresses, you can replay the exact scan that taught it the wrong thing.
6. **Dedupe aggressively but never silently.** Dedup decisions are logged, not hidden.

## Train/Test Split Discipline (Tier 1/2/3)

This is the single spec for how any captured card ever ends up in training vs evaluation. It scales from 33 unique cards to 10,000+ without rewrites because membership is determined at ingestion time and never rebalanced.

### The three tiers

| Tier | Name | Source | Purpose | Mutability | Used for |
| --- | --- | --- | --- | --- | --- |
| **Tier 1** | Frozen legacy | `qa/raw-footer-layout-check/` | Historical regression suite. Every candidate adapter must hit these gates. | Immutable. Never add, never remove, never retrain on these cards. | Eval only |
| **Tier 2** | Expansion holdouts | `qa/raw-visual-expansion-holdouts/` | Held-out slice representing new cards entering the pipeline. Validates generalization on unseen cards. | Grows only by automated routing at session close. Once added, frozen. | Eval only |
| **Tier 3** | Rolling training set | `~/spotlight-datasets/raw-visual-train/safe_new` and `safe_training_augment` | Live training corpus. Grows every labeling session. | Grows by automated routing. | Training only |

### Core invariants

1. **Split by `providerCardId`, never by image.** A given card ID is either a Tier 1 card, a Tier 2 card, or a Tier 3 card. It never appears in two tiers. This is the single rule that prevents leakage.
2. **Once training, always training. Once holdout, always holdout.** The tier assigned to a `providerCardId` at first sighting is its tier forever. This is enforced by `raw_scan_registry.json` — the registry stores `providerCardId → tier` and is append-only.
3. **Tier 1 is the hardest boundary.** Any perceptual-hash match OR `providerCardId` match against Tier 1 is a hard block in the contamination firewall (see "Contamination Firewall"). Tier 1 membership pre-dates the data loop and does not grow.
4. **Tier 2 gets `15–25%` of new `providerCardId`s per batch.** When a labeling session closes with N new-to-pipeline `providerCardId`s, a deterministic share (15–25%, exact percent set at batch open) is reserved for Tier 2. The rest goes to Tier 3. See "Automated Tier Routing" for the exact algorithm.
5. **Tier 2 grows monotonically but slowly.** Never more than 25% of any batch. This keeps the holdout representative of expansion without starving Tier 3.
6. **Every training manifest build reads the registry.** If a `providerCardId` is marked Tier 1 or Tier 2, the manifest builder refuses to include it in training, regardless of where the image file happens to sit on disk.

### Scaling properties

- **No rebalancing.** Membership is decided once; nobody ever has to "move" a card between tiers. This is why the system scales.
- **Monotonic growth.** The registry only grows. Rows are never deleted, only marked `retired` if a card's images are removed for legal / quality reasons.
- **Per-batch determinism.** The tier assignment function is `tier(providerCardId, batch_salt) = hash(providerCardId + batch_salt) % 100 < tier2_pct ? "tier2" : "tier3"`. Re-running on the same batch gives the same answer.
- **Auditability.** Every `providerCardId` in the registry has a `first_seen_scan_id`, `first_seen_batch_id`, and `assigned_tier_at` timestamp, so any training/eval regression can be traced to the batch that introduced the card.

### Why this is the source of truth

The older `safe_new / safe_training_augment / heldout_blocked / manual_review` folder layout (described in `raw-visual-local-dataset-workflow-2026-04-12.md`) is the **filesystem** layout. Tier 1/2/3 is the **membership** layout. They complement each other:

- A file in `safe_training_augment/` whose `providerCardId` is Tier 2 in the registry is a bug — the import tool catches it and routes the file to `heldout_blocked/` instead.
- A file in `heldout_blocked/` whose `providerCardId` is Tier 3 never gets flipped back — the registry is append-only.

If the two ever disagree, the registry wins. The folder layout is an artifact produced from the registry, not a source of truth on its own.

## Data Model

### Existing tables (do not modify schema beyond additions)

From `backend/schema.sql`:

- `scan_events(scan_id, predicted_card_id, selected_card_id, selected_rank, was_top_prediction, confirmed_card_id, review_disposition, resolver_mode, matcher_version, ...)` — the scan trust gradient is already here. Keep.
- `scan_artifacts(scan_id, source_object_path, normalized_object_path, source_width, source_height, normalized_width, normalized_height, camera_zoom_factor, capture_source, upload_status, artifact_version, ...)` — keep.
- `scan_prediction_candidates(id, scan_id, rank, card_id, final_score, candidate_json)` — the top-K is already persisted. Keep.
- `scan_confirmations(id, scan_id, confirmed_card_id, confirmation_source, selected_rank, was_top_prediction, deck_entry_id, ...)` — Add-to-deck labels are already here. Keep.
- `deck_entries(id, card_id, source_scan_id, source_confirmation_id, ...)` — links confirmed scans into the user's deck. Keep.

### Additions in this spec

1. Add `user_id TEXT` column to:
   - `scan_events`
   - `scan_artifacts`
   - `scan_confirmations`

   Nullable until multi-user auth is forced at scan ingestion. Backfill with `NULL` on existing rows. `request_auth.py` already returns a `RequestIdentity` on every authenticated request; wire it into `/api/v1/scan-artifacts` and all scan endpoints so the `user_id` is stamped at write time.

2. Add a new `scan_labeling_reviews` table for friend-reviewer labels that are not `Add-to-deck` events. Rationale: we want a way for a trusted reviewer to label someone else's scan without creating a deck entry.

   ```sql
   CREATE TABLE IF NOT EXISTS scan_labeling_reviews (
       id TEXT PRIMARY KEY,
       scan_id TEXT NOT NULL REFERENCES scan_events(scan_id) ON DELETE CASCADE,
       reviewer_user_id TEXT NOT NULL,
       reviewer_role TEXT NOT NULL,             -- 'owner', 'friend', 'admin'
       labeled_card_id TEXT REFERENCES cards(id) ON DELETE CASCADE,
       label_disposition TEXT NOT NULL,         -- 'confirmed', 'unclear', 'not_in_top_10', 'skip'
       selected_rank INTEGER,
       was_top_prediction INTEGER,
       notes TEXT,
       created_at TEXT NOT NULL,
       UNIQUE(scan_id, reviewer_user_id)
   );
   ```

3. Add a `scan_training_export_runs` table so every training-manifest export is auditable:

   ```sql
   CREATE TABLE IF NOT EXISTS scan_training_export_runs (
       id TEXT PRIMARY KEY,
       created_at TEXT NOT NULL,
       scan_ids_exported_json TEXT NOT NULL,
       row_count INTEGER NOT NULL,
       filters_json TEXT NOT NULL,
       output_csv_path TEXT NOT NULL,
       active_artifact_version TEXT NOT NULL
   );
   ```

## The Label Trust Gradient

The backend persists every state, but only gold promotes to training.

| State                                            | Source                                                     | Trust  |
| ------------------------------------------------ | ---------------------------------------------------------- | ------ |
| `predicted_card_id`                              | backend top-1 at scan time                                 | None   |
| `selected_card_id` without confirmation          | user tapped an alternate in the scan tray                  | Weak   |
| `confirmed_card_id` via `Add to deck`            | scan owner added the card to their inventory              | Gold   |
| `scan_labeling_reviews.label_disposition=confirmed` (reviewer_role `owner`) | scan owner explicitly confirmed in a review UI             | Gold   |
| `scan_labeling_reviews.label_disposition=confirmed` (reviewer_role `friend`) | friend reviewer explicitly confirmed                       | Gold   |
| `scan_labeling_reviews.label_disposition=confirmed` (reviewer_role `admin`) | project maintainer confirmed                               | Gold   |
| `scan_labeling_reviews.label_disposition=unclear` | reviewer couldn't decide                                   | None (exclude from training) |
| `scan_labeling_reviews.label_disposition=not_in_top_10` | reviewer says the right card isn't in the candidate list  | Negative signal (see below) |

**Weak labels are intentionally not promoted to gold by time or repetition.** If a user taps an alternate, that's a signal — not a label. Promotion requires an explicit confirmation event.

**`not_in_top_10` rows are valuable.** They tell us exactly when the visual retrieval *missed*, not just when it got reordered. These rows go into a separate "missed retrieval" register used to drive hard-negative selection and corpus expansion targets (see "Using missed retrievals" below).

## The Top-10 Labeling Surface

This is the core of the user's insight: labeling is a pick-one-of-ten UX, not typing.

### Who can see what

- **Scan owner**: sees their own scans with full artifacts.
- **Friend reviewer**: sees scans from users who have opted into friend-review, scoped to scans where `review_disposition = needs_review` OR `confirmed_card_id IS NULL` AND scan is older than 1 hour (owner had a chance).
- **Admin (the project maintainer)**: sees all scans. Used for debug and bootstrap.

### The labeling action

Per scan, a reviewer sees:

- The `normalized_target` image (no source_capture to protect background context).
- The top-10 candidate list with artwork, name, set, collector number.
- Four action buttons:
  1. **Pick #N**: mark `labeled_card_id = candidate[N].card_id`, `label_disposition = confirmed`.
  2. **Unclear**: `label_disposition = unclear`. Hurts top-1 stats for that scan, but frees up the queue.
  3. **Not in top-10**: `label_disposition = not_in_top_10`. Triggers the "missed retrieval" path (see below).
  4. **Skip**: no row written. Scan stays in queue for another reviewer.

### Per-scan review rules

- A single scan can have multiple `scan_labeling_reviews` rows from different reviewers.
- A scan is considered gold-labeled if at least one `confirmed` row exists from a reviewer with role `owner` or `admin`, OR two `confirmed` rows from `friend` reviewers agreeing on the same `labeled_card_id`.
- A scan with any `unclear` row from the owner is treated as ambiguous (excluded).
- A scan with a `confirmed` row AND a later `confirmed` row pointing to a different card triggers a `label_conflict` flag; excluded from training until resolved by admin.

### Using `not_in_top_10`

A scan marked `not_in_top_10` is not discarded:
- It gets written into a `missed_retrieval_queue` (simple JSON log, not a table, lives at `~/spotlight-datasets/raw-visual-train/missed_retrievals.jsonl`).
- The admin can later resolve it by matching the normalized image against the Scrydex catalog manually (using the manual-card-search v1 surface — see `docs/manual-card-search-v1-spec-2026-04-20.md`).
- Once resolved, the scan becomes a training example with a strong hard-negative signal: "the model ranked these 10 cards, but none of them was right."
- During training, `not_in_top_10` rows drive oversampling of the confusion cluster of the correct card for the next corpus-expansion cycle.

## Labeling Sessions (Admin Role)

A "labeling session" is how we produce training-grade multi-angle captures. Not every authenticated user can start one — the admin (project maintainer) grants the `labeler` role to specific users.

### Role + gating

- New column on the user record: `labeler_enabled BOOLEAN DEFAULT FALSE`. Admin flips this per-user via a simple admin tool (`tools/grant_labeler_role.py --user-id <id>`), no UI needed for v1.
- The iOS app reads this flag from the user profile at launch. The "Start labeling session" entry point in the scanner is hidden unless `labeler_enabled = true`.
- The flag is never self-service. A user cannot opt themselves in.

### Session lifecycle

1. **Start session**: labeler taps "Start labeling session", enters/confirms the target card via the top-10 list, the Scrydex search, or the manual-search surface. This establishes the session's `labeled_card_id` up front.
2. **Capture angles**: labeler takes N captures of the same physical card (target: `≥ 3`, up to `~8`). Each capture emits a normal `scan_event` + `scan_artifact`, stamped with a shared `labeling_session_id`.
3. **Close session**: tapping "Done" finalizes the session. All captures in that session inherit:
   - `label_disposition = confirmed`
   - `labeled_card_id = <session card>`
   - `reviewer_role = 'labeler'` (a new value in `scan_labeling_reviews.reviewer_role`, stored in a single session-summary row linked back to each capture).
4. **Abort session**: tapping "Discard" drops all captures from the session. No artifacts persist. Prevents half-labeled data from contaminating anything.

### Storage: GCS from day one for labeling sessions

Labeling-session captures are the canonical training-data source. They are not a short-term artifact.

- Both `source_capture` and `normalized_target` upload to GCS immediately at session close.
- GCS layout: `gs://spotlight-labeling-sessions/<user_id>/<yyyy>/<mm>/<dd>/<labeling_session_id>/{angle_N}/{source,normalized}.jpg`
- The `scan_artifacts.source_object_path` and `normalized_object_path` point at the GCS object (not a local filesystem path).
- Non-labeling-session (regular) scans keep the existing local-first path; they migrate to GCS on a slower timeline per the rollout stages.
- Retention for labeling-session artifacts is indefinite. They are training data.

### Schema additions for labeling sessions

```sql
CREATE TABLE IF NOT EXISTS labeling_sessions (
    id TEXT PRIMARY KEY,
    labeler_user_id TEXT NOT NULL,
    labeled_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    provider_card_id TEXT NOT NULL,          -- denormalized for fast tier-routing lookup
    captured_angle_count INTEGER NOT NULL,
    session_state TEXT NOT NULL,             -- 'open', 'closed', 'aborted'
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    tier_assignment TEXT,                    -- 'tier2' | 'tier3' — populated at close by router
    routed_batch_id TEXT
);

ALTER TABLE scan_events ADD COLUMN labeling_session_id TEXT REFERENCES labeling_sessions(id) ON DELETE SET NULL;
```

### Multi-angle capture UX rules

- Reticle guidance overlay prompts: "Angle 1 of 3: dead-on", "Angle 2 of 3: tilt left", "Angle 3 of 3: tilt right". These are prompts, not hard validation — the labeler decides when the angle is good.
- Each angle enforces the same `pixels_per_card_height ≥ threshold` health check the normal scanner uses. A capture below threshold is rejected with a re-shoot prompt instead of silently accepted.
- The labeler can review all angles captured in the session before closing. Individual angles can be discarded.

## The Spreadsheet / CSV Tracking

The user wants a spreadsheet / CSV that captures the data loop state. This is what `tools/export_scan_training_rows.py` produces.

### Output shape

One CSV per export run at `~/spotlight-datasets/raw-visual-train/exports/scan_training_export_<timestamp>.csv` with these columns:

| Column | Source |
| --- | --- |
| `scan_id` | `scan_events.scan_id` |
| `created_at` | `scan_events.created_at` |
| `user_id` | `scan_events.user_id` |
| `active_artifact_version_at_scan_time` | `scan_events.matcher_version` |
| `predicted_card_id` | `scan_events.predicted_card_id` |
| `predicted_card_name` | join `cards.name` |
| `predicted_rank_1_score` | `scan_prediction_candidates.final_score` where `rank=1` |
| `confirmed_card_id` | `scan_confirmations.confirmed_card_id` (preferred) or `scan_labeling_reviews.labeled_card_id` (fallback if scan gold by reviewer) |
| `confirmed_card_name` | join `cards.name` |
| `confirmation_source` | `Add-to-deck`, `reviewer_owner`, `reviewer_friend`, `reviewer_admin` |
| `was_top_prediction` | boolean: did predicted == confirmed |
| `confirmed_rank_in_top_10` | rank of confirmed card in the 10 candidates, or `-1` if missed |
| `source_object_path` | `scan_artifacts.source_object_path` |
| `normalized_object_path` | `scan_artifacts.normalized_object_path` |
| `camera_zoom_factor` | `scan_artifacts.camera_zoom_factor` |
| `pixels_per_card_height` | `scan_artifacts.pixels_per_card_height` (added in Phase 1) |
| `rectangle_source_branch` | `rectangle` or `exact_reticle` |
| `rerank_source` | `ocr_confident`, `visual_only`, `leader_protected` |
| `ocr_footer_text` | best-effort footer text at scan time |
| `ocr_footer_confidence` | number |
| `ocr_title_text` | best-effort title text |
| `total_ms` | end-to-end scan latency |
| `label_disposition` | `confirmed`, `unclear`, `not_in_top_10`, `owner_add_to_deck`, `unlabeled` |
| `training_bucket_target` | `safe_new`, `safe_training_augment`, `heldout_blocked`, `manual_review`, `excluded` |
| `excluded_reason` | populated if the row is excluded from training |
| `notes` | any reviewer notes |

Why CSV specifically: the user already has an XLSX/TSV ingest path (`process_raw_visual_batch.py`). Producing CSV in the same shape keeps round-trippability — you can hand the CSV to the friend, they add notes, you re-import it.

### How the CSV gets used

1. `tools/export_scan_training_rows.py` reads from the backend SQLite (or its mirror), applies filters (`--since`, `--user-id`, `--min-confidence`, `--reviewer-role`), resolves which bucket each row belongs in, and writes the CSV.
2. Optionally open the CSV in Google Sheets for a human sanity check — the file is already flat and human-readable.
3. `tools/import_confirmed_scans_to_training.py` takes the CSV and:
   - Copies `normalized_object_path` images into the right bucket folder under `~/spotlight-datasets/raw-visual-train/`.
   - Generates the per-fixture folder layout (`source_scan.jpg`, `runtime_normalized.jpg`, `truth.json`) that the existing training-manifest builder expects.
   - Dedupes by perceptual hash against the existing training manifest and the frozen legacy suite. Any hash collision with the frozen suite goes to `heldout_blocked`.
   - Writes a matching `scan_training_export_runs` row so the ingestion is auditable.
4. `tools/build_raw_visual_training_manifest.py` then runs as normal — it does not need to know that these rows came from live scans.

## Contamination Firewall

Every import run must satisfy, automatically, before any file is written into `safe_training_augment`:

1. No normalized image whose perceptual hash matches any image in `qa/raw-footer-layout-check/`.
2. No `providerCardId` whose truth row appears in `qa/raw-footer-layout-check/`.
3. No scan from a user who has contributed to the frozen legacy suite.

Implementation: a single function in `tools/import_confirmed_scans_to_training.py` named `assert_no_frozen_contamination(rows)` that raises if any of the above is violated. It runs before any filesystem writes.

Add a CI check: `tools/run_contamination_assertion.sh` that compares the current training manifest against the frozen legacy suite and fails non-zero on overlap. Run this on every training-manifest rebuild.

## Automated Tier Routing

When a labeling session closes, the backend decides whether the captured card enters Tier 2 (expansion holdout) or Tier 3 (rolling training set). No human picks. The routing function is deterministic and idempotent.

### The routing function

Input: a closed `labeling_session` with `provider_card_id`, `labeled_card_id`, and all its capture `scan_ids`.

Algorithm:

```
route_session(session):
    # Step 1: contamination check (hard block)
    if provider_card_id in tier1_set:
        mark session 'contaminated_tier1'
        route all captures to qa/heldout_blocked
        return

    # Step 2: registry lookup
    registry = load(raw_scan_registry.json)
    if provider_card_id in registry:
        # Existing card — keep its assigned tier. No reassignment ever.
        tier = registry[provider_card_id].tier
    else:
        # New card — deterministic reservation
        batch_id, tier2_pct = current_open_batch()  # e.g. 20%
        bucket = hash(provider_card_id + batch_id) % 100
        tier = 'tier2' if bucket < tier2_pct else 'tier3'
        registry.append({
            provider_card_id,
            tier,
            first_seen_scan_id: session.first_capture_scan_id,
            first_seen_batch_id: batch_id,
            assigned_tier_at: now(),
            labeling_session_id: session.id,
        })
        save(registry)

    # Step 3: route files
    target_dir = tier2_dir if tier == 'tier2' else tier3_dir
    copy normalized + truth.json for each capture into target_dir

    # Step 4: stamp session
    session.tier_assignment = tier
    session.routed_batch_id = batch_id
```

### Why this scales without human intervention

- **Idempotent.** Running the router twice on the same session is a no-op after the first run — the registry already has the entry.
- **Deterministic.** Given the same `provider_card_id` and `batch_id`, the same tier is chosen every time. This is testable.
- **No rebalancing logic.** New cards get hashed into a tier; existing cards stay in their tier. There is no case where the router needs to ask a human.
- **Per-batch tier2_pct control.** The admin can dial the tier-2 percentage per batch (15–25%) if holdout growth is too fast or too slow. It never retroactively reassigns old cards.

### Batch semantics

A "batch" is an admin-opened window. `tools/open_labeling_batch.py --tier2-pct 20` creates a batch row with an explicit percentage. Every new-card routing decision during that batch uses that percentage. A batch closes when the admin runs `tools/close_labeling_batch.py`; after that, the next session's new cards start counting under the next batch.

Batches exist for two reasons:
1. They give the admin a knob to tune tier-2 growth without editing code.
2. They produce a natural audit trail: "these 47 new cards entered in batch #12 on 2026-05-07 with 20% tier-2 reservation."

### Registry file location

`~/spotlight-datasets/raw-visual-train/raw_scan_registry.json`. Checked into the local dataset tree. Authoritative copy backed up to GCS on every write: `gs://spotlight-labeling-sessions/_registry/raw_scan_registry.json`.

## Dedupe

Two dedupe stages:

1. **Within a single scan session:** scans from the same user within 5 seconds on the same card are treated as one session. Keep the scan with the highest `target_selection_confidence`, drop the rest. Implemented in `tools/export_scan_training_rows.py`.

2. **Across sessions and users:** perceptual hash on `normalized_target`. Hashes within hamming distance `≤ 6` of an existing training-manifest image are skipped. Same-card across users is fine (diversity is valuable); identical images are not.

## Rollout Stages

These match the Phase 3 entry and exit gates in the scanner rewrite spec.

### Stage A: local-only bootstrap (1 week)

- User `user_id = 'admin'` is the only allowed scan-uploader.
- The admin scans ~100 cards personally. Friend is not yet in the loop.
- Verify CSV export + import produces the same 100 cards as training-ready fixtures.
- Run a smoke retrain on the expanded corpus; verify eval pipeline end-to-end.

Exit gate: 100 scans round-trip cleanly from backend to training manifest with zero manual edits.

### Stage B: friend-review ramp (2 weeks)

- Add friend's `user_id` with role `friend`.
- Admin scans 200+ more cards. Friend reviews them via the labeling UI.
- Target: 150+ gold-labeled scans. Watch for label conflicts and ambiguity.
- Run the contamination assertion on every export.

Exit gate: 200 gold-labeled scans, zero contamination-assert failures, zero unresolved label conflicts.

### Stage C: retrain cycle (1 week)

- Retrain adapter on the expanded corpus.
- Evaluate per the rewrite-spec Phase 4 gates.
- Publish if gates met; roll back if not.

Exit gate: published or rejected candidate with a decision record.

### Stage D: ongoing loop (recurring)

- Every week: export CSV, review new scans, retrain candidate if new gold count exceeds `+50` cards.
- Every month: rotate a small held-out expansion slice into `qa/raw-visual-expansion-holdouts/` (never into `qa/raw-footer-layout-check/`).
- Every quarter: review whether OCR removal gates are being approached.

## Communication To Friends

The friends contributing labeling sessions are not ML engineers. They need a clear, short explanation of what they're doing and why the structure matters. Use the text below as the canonical brief — copy into a message when onboarding a new friend.

### What to send a friend (copy-paste ready)

> Hey — thanks for helping label cards for the Spotlight scanner. Here's what you need to know so your work ends up actually training the model.
>
> **What you're doing.** You open the scanner, start a "Labeling session," pick the correct card once, then take 3–5 photos of the same physical card at different angles. Tap Done. That's one labeled card. The app does the rest.
>
> **What makes a labeling session good.**
>
> 1. **Pick the card correctly once.** The whole session inherits that label, so if you pick wrong, every angle is wrong. Double-check the set and collector number.
> 2. **3 to 5 angles per card.** Dead-on, tilt left, tilt right, slight tilt forward, slight tilt back. All with the card fully inside the reticle.
> 3. **Card fills the reticle.** If the card is tiny in the frame, the training data is junk. The app will reject too-small captures — just re-shoot.
> 4. **Good lighting, matte surface.** Avoid glare on holo cards; avoid shadows crossing the card. A white or grey tabletop under even light is ideal.
> 5. **One card per session.** Don't switch cards mid-session. If you bump the card, either keep the same card or close and start a new session.
>
> **Which cards to buy / borrow.**
>
> - **Variety beats volume.** 50 different cards in a week is better than 200 scans of 10 cards.
> - **Target the weak spots.** I'll share a weekly "wanted list" — cards the model is missing or confusing. Prioritize those over random pulls.
> - **Reprints are gold.** If a card has multiple printings (same art, different set / holo / stamped), each printing counts as a separate card and is especially valuable — those are the cards the model confuses today.
> - **Avoid: sleeved cards, scribbled-on cards, heavily scratched holos, slabbed cards.** (Slabs go through a separate pipeline.)
>
> **What happens to your captures.**
>
> - Every capture goes into Google Cloud Storage under your user folder. Only I (admin) can see everything; the model training reads from there.
> - Some cards you label will go into "training" (the model learns from them). Some will go into "holdout" (used to measure if training is working). The app picks automatically — you don't choose.
> - Target: ~50 labeled cards per week per person is plenty. More is welcome if you're having fun; just keep the structure above.
>
> **What NOT to do.**
>
> - Don't label a card you're unsure about. If in doubt, skip. A wrong label poisons the training.
> - Don't re-photograph cards you've already labeled before without asking — we dedupe but it wastes your time.
> - Don't share your login. The labeler role is granted per-person for provenance.

### Admin-side support

- Keep a shared Google Doc with the weekly wanted list (cards the model is missing). Update it after every retrain cycle.
- Share the current training corpus size and model accuracy with friends in a monthly update. They're contributing to a system they should be able to watch improve.
- Acknowledge good captures. A one-line "this batch pushed top-1 from 84% to 87%" is the kind of feedback that keeps people engaged.

## Privacy

- `scan_artifacts` files are private per-user-scoped directories: `backend/data/scan-artifacts/scans/<user_id>/<yyyy>/<mm>/<dd>/<scan_id>/`.
- When we migrate to GCS: separate prefixes per user, IAM-scoped signed URLs only.
- The friend reviewer sees only other users' `normalized_target`, never `source_capture` (background may contain incidental PII).
- Users can opt out of training use per-scan (a toggle in the scan tray) and bulk via settings. An opted-out scan is still stored for the user's personal use but excluded from any training export.
- Storage retention: 180 days for `source_capture`, indefinite for `normalized_target` on opted-in scans.

## Metrics To Track In The Loop

These are health metrics of the data pipeline itself, not the model.

- Gold-labeled scans per week (goal: `≥ 50` once Stage B is running).
- Label-conflict rate (goal: `< 2%`; higher means the top-10 is too ambiguous or reviewer quality is low).
- `not_in_top_10` rate per week (goal: declines over time; steady or rising means the model is missing important cards — feed back into corpus expansion targets).
- Dedupe rate (goal: `< 40%`; much higher means friends are scanning the same cards repeatedly — worth suggesting diversity).
- Contamination-assertion failures (goal: always zero; any failure is a bug).
- Export-to-import round-trip time (goal: `< 10 min` for a 1000-scan batch).

## Tools To Build

New:

1. `tools/export_scan_training_rows.py` — CSV exporter, described above.
2. `tools/import_confirmed_scans_to_training.py` — CSV importer with contamination firewall.
3. `tools/run_contamination_assertion.sh` — CI-friendly contamination check.
4. `tools/resolve_missed_retrievals.py` — admin tool for working through `missed_retrievals.jsonl`.

Extend:

5. `backend/scan_artifact_store.py` — accept `user_id` from request auth.
6. `backend/server.py` — stamp `user_id` on every scan write; add `matcher_version` resolution on every response; add `rerank_source` and `pixels_per_card_height` to responses.
7. `Spotlight/Views/ScannerRootView.swift` + `Spotlight/Views/AlternateMatchesView.swift` — add the friend-labeling tray.
8. Later, `apps/spotlight-rn/src/features/scanner/` — port the labeling tray to RN.

## What This Spec Does Not Do

- Does not define the friend-labeling UI pixel design. Start with a minimal vertical list + tap. Iterate after Stage A.
- Does not introduce a new labeling web tool. The iOS tray is the labeling UI.
- Does not require a dedicated labeling database. Everything lives in the existing `backend/schema.sql`.
- Does not change the existing bulk xlsx/csv import path. That path stays open for external labeled corpora.
- Does not ship a public API for third-party annotation. Friends authenticate via the same Supabase JWT used elsewhere.

## Open Questions

None at time of publication (2026-04-23). All Phase 2 entry questions have been resolved — see "Decisions Locked 2026-04-23" near the top of this document. Add future open questions here with a dated sub-heading so the history is visible.
