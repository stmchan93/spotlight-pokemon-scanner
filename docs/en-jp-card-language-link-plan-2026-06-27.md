# EN↔JP Card Language Link + PDP Toggle — Plan

_2026-06-27._

## Context

The PDP already renders an EN/JP toggle (`card-detail-screen.tsx` `selectedLanguage`, wired into `CardConfigurator`), but it's **inert** — the code comment says *"UI-only for now (not sent to the backend)."* The intent: toggling EN/JP should switch the PDP to the **actual other-language card** (a distinct product with its own set, image, and pricing), and the toggle should be **hidden when no counterpart exists**.

The blocker is data: EN and JP cards are separate catalog rows with separate IDs and **no cross-language link**. Investigation findings:
- **Scrydex** has no counterpart-ID field. A JP card's `translation.en` only localizes that same card's labels; it does not point to the English card row. EN/JP **set codes/totals/tcgplayer IDs all differ** — nothing to join on.
- **PPT** has no language linkage (keyed by language-specific `tcgPlayerId`).
- The one signal that crosses languages reliably is the **artwork** (identical worldwide; only border/text/symbols differ).

Measured on the real catalog (23,827 EN / 20,659 JP):
- `artist` populated (~99% EN, ~94% JP). **`national_pokedex_numbers` and `regulation_mark` columns are empty** (0/44k) — the sync drops them, though they exist in `source_payload_json`.
- **English name + artist alone → a unique EN counterpart for 55% of JP cards**; ~7% have no name match (true exclusives); ~37% are ambiguous (same Pokémon + illustrator reprinted across sets) and need the artwork to disambiguate.

## Approach (deterministic-ish: metadata prune → artwork embedding → threshold → "no counterpart" fallback)

The artwork embedding is the **decider**, not a tail tiebreak. Pipeline per card:
1. **Prune** candidates in the other language by `english_name + artist` (after backfill, also `national_pokedex_numbers` + `regulation_mark`). Reduces to a handful.
2. **Match** on a **SigLIP2 embedding of the art crop** (`ARTWORK_V1_CROP_BOX`, excludes border/text) — cosine NN restricted to the pruned candidates.
3. **Threshold**: keep the best only if cosine ≥ a calibrated floor; otherwise record **no counterpart** (handles exclusives + re-illustrated cards like Misty's Tears).
4. "Counterpart" = **card identity, not a specific SKU**. If several other-language prints share the art (promos/reverse-holo), pick the highest score (tiebreak: lowest collector number). Acceptable for v1.

Reuses existing infra: `RawVisualFrozenEncoder.embed_images()` (`backend/raw_visual_model.py`), `apply_crop_preset()` + image cache (`tools/build_raw_visual_index.py`), cosine search pattern (`backend/raw_visual_index.py`). The active backbone is SigLIP2-384.

## Build phases

### Phase A — safe, reversible plumbing (this PR; degrades to a hidden toggle until the table is populated)
1. **Schema** (`backend/schema.sql`): `card_language_links(card_id PK, counterpart_card_id, counterpart_language, match_score, match_method, created_at)`. Directed rows (store both EN→JP and JP→EN) for O(1) PDP lookup.
2. **Backfill script** (`tools/backfill_card_pokedex_regmark.py`): extract `national_pokedex_numbers` + `regulation_mark` from `cards.source_payload_json` into the columns (idempotent). Tightens pruning; also fixes a latent data-completeness gap.
3. **Linker script** (`tools/build_card_language_links.py`): runs the pipeline above and writes `card_language_links`. The candidate-selection + scoring core is a pure function (unit-testable without the model).
4. **Backend payload**: `_card_counterpart(card_id)` helper + add `counterpartCardId`, `counterpartLanguage`, and the card's own `language` to the `card_detail` payload (gated to the single-card path, like the social counts). Returns nulls until the table is populated → safe no-op.
5. **API client**: add `language`, `counterpartCardId`, `counterpartLanguage` to `CardDetailRecord` (+ HTTP/mock mapping).
6. **RN**: drive the existing toggle from `detail.language` + `detail.counterpartCardId`; **hide it when no counterpart**; on switching, `router.replace` the detail route with the counterpart cardId (reuses all load/pricing logic). Reset on card change.
7. **Tests**: backend test for the counterpart payload; unit test for the linker's prune/select core with synthetic embeddings.

### Phase B — offline run + calibration (ops, not code)
- Run backfill → embed art crops for all ~44k cards (reuse the build cache) → build `card_language_links`.
- Calibrate the cosine floor on a small known-pairs set (e.g. Base Set Charizard EN↔JP, modern chase cards) — target high precision (a wrong toggle is worse than a hidden one).
- Spot-check coverage/precision; deploy the table + backfill.

## Critical files
- `backend/schema.sql`, `backend/server.py` (`_card_detail_for_context`, `card_detail`)
- `backend/raw_visual_model.py`, `tools/build_raw_visual_index.py` (crop + encoder to reuse), `backend/raw_visual_index.py`
- `packages/api-client/src/spotlight/{types.ts,repository.ts}`
- `apps/spotlight-rn/src/features/cards/screens/card-detail-screen.tsx`, `components/card-configurator.tsx`

## Verification
- Backend unit test: linker selects the correct candidate given synthetic embeddings + prune metadata; respects the threshold (no link below floor).
- Backend test: detail payload exposes `counterpartCardId`/`counterpartLanguage`/`language`; null when no row.
- After Phase B run: assert known pairs link (Charizard etc.), exclusives don't, re-illustrated cards don't; eyeball precision on a sample.
- App: PDP shows the toggle only for linked cards; switching swaps to the counterpart with its own pricing; hidden otherwise.
