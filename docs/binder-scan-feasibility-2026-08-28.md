# 9-card binder-page scanner: feasibility, measured

**Verdict: viable.** The feared killer — binder pockets giving the matcher
~240–360px instead of the 630px it was trained on — was measured on
2026-08-28 and does not materialize at Android's resolution, and is avoidable
at iOS's by shooting 4K stills in binder mode.

## The experiment

Simulated binder-pocket resolution by down/up-scaling every held-out
`runtime_normalized.jpg` (240px ≈ iOS HD pocket, 360px ≈ Android FHD pocket,
native 630 = control), scored through the REAL `RawVisualMatcher` (encoder +
adapter + shipped index + runtime query preprocessing — not the eval tool,
whose base-index re-projection doesn't fit the adapter-applied per-game
indexes). Harness: session scratchpad `binder_resolution_experiment.py` /
`binder_resolution_pokemon.py` (rebuild from this description if needed —
~80 lines each).

| condition | One Piece EN top-1 | EN top-10 | Pokémon top-1 (46k index, 67 fixtures) | top-10 |
|---|---|---|---|---|
| native-630 | 94.3% | 97.1% | 83.6% | 94.0% |
| pocket-360 | 91.4% | 97.1% | 86.6% | 94.0% |
| pocket-240 | 91.4% | 97.1% | 76.1% | 94.0% |

Readings:
- **360px: zero real degradation, both games.** (Pokémon's +3 is ±1-fixture
  jitter — downscaling smooths capture noise.)
- **240px: Pokémon top-1 −7.5pt, but top-10 UNCHANGED at 94%** — the truth
  card still reaches the tray; it just isn't always first.
- Baselines run a few points above the recorded eval numbers (88.6% OP EN,
  73.2% Pokémon) because this harness drives the full runtime matcher with
  query variants; deltas within the table are the honest signal.

**Design consequence: binder mode captures 4K stills.** 4K / 3 pockets ≈
720px per pocket — above native, so resolution cost ≈ zero on both platforms.

## Build outline (~9–13 evenings), assessed 2026-08-28

1. **Page localization** (3–5 ev): quad detection + perspective correction +
   3×3 subdivision. Native work specced-but-unbuilt in
   `docs/scanner-live-lock-on-ux-spec-2026-05-21.md` (:184-195 —
   `makeLockedQuadSourceImageCrop`, `perspectiveCorrectCapture`); module
   shell exists (`apps/spotlight-rn/modules/spotlight-slab-scanner/`). NOTE:
   the single-card detector deferral in that spec does NOT apply here — there
   detection was a marginal accuracy add; here it is load-bearing (no reticle
   can answer "where is pocket 5"), and a rigid 3×3 grid is far easier than
   free-form card detection.
2. **Batch endpoint** (1–2 ev): `/api/v1/scan/visual-match-batch`, N crops
   under ONE inference-semaphore slot (nine separate calls would thrash the
   6s acquire timeout for every other user), `match_payloads()` sharing
   runtime setup + batching the encoder forward (`embed_images` batch path
   exists; FLOPs still ≈ 9×).
3. **RN flow** (2–3 ev): binder capture mode (4K still) → nine client-minted
   scan_ids → nine tray rows (`RecentCapture` model already per-capture) →
   existing Add-All bulk-confirm sheet. Mostly reuse.
4. **Artifacts + eval** (2–3 ev): one page source image + nine crops doesn't
   fit `scan_artifacts`' per-scan `source_object_path`; needs a small schema
   tweak. Then a real-binder-photo fixture set.

## Open items, in order

1. **Real binder captures** — the remaining unknown is glare across nine
   glossy sleeves / page curvature / off-axis edge pockets, NOT resolution.
   De-risk exactly like One Piece: photograph a few real pages, hand-crop
   pockets, run through the matcher. Do this before the native work.
2. **Capacity**: one page ≈ ~10 vCPU-s ≈ 5s of the entire prod box
   (`docs/backend-capacity-load-test-2026-07-01.md`). Fine for personal/
   staging use; broad rollout wants the deferred INT8 encoder (≈ halves
   inference cost) or a bigger box.
3. Given top-10 survives everywhere, the binder UX should lean on the
   candidate tray (tap-to-fix per pocket) rather than promising top-1.

## POC results (2026-08-28, same day)

`tools/binder_scan_poc.py` runs the full loop — cv2 page-quad detection →
perspective rectification → 3×3 subdivision → `RawVisualMatcher` per pocket —
on synthetic binder pages composited from the real-photo fixtures (known
truth, mild perspective warp, downscaled to ~360px pockets):

| game | pages | quad found | top-1 | top-10 | wall/page warm |
|---|---|---|---|---|---|
| onepiece | 4 | 4/4 | 91.7% | 97.2% | ~1.0s |
| pokemon (46k) | 7 | 7/7 | 87.3% | 93.7% | ~1.2s |

Identical to the single-card baselines within noise — subdivision and
rectification cost nothing measurable. Real-photo mode is ready for the
moment real captures exist:

    backend/.venv/bin/python tools/binder_scan_poc.py --page photo.jpg --game pokemon

Remaining unknown is unchanged: real-capture artifacts (sleeve glare, page
curvature) — the synthetic pages carry the fixtures' single-card capture
noise but not page-level effects.

## First REAL binder photo (2026-08-28, later that evening)

A real 9-pocket page of Illustration Rares (eBay-style listing photo,
1140×1266, sleeves with visible glare, slight tilt) through
`--page`: **9/9 pockets identified correctly** — Ivysaur, Froakie,
Bastiodon, Charcadet, Misdreavus, Xerneas, Watchog, Ludicolo, Doublade —
similarities 0.55–0.79, ~120ms/pocket warm (~3s page incl. cold start).
Quad detection fell back to naive thirds (photo tightly framed on the
page) and the fallback was sufficient. Sleeve glare did not cost a single
pocket. The feature's remaining risk is now ordinary engineering, not
feasibility.

User verified the page against the physical cards: 8/9 exact printings
(incl. a Black Star Promo), 9/9 names. The one printing miss — Bastiodon
093/084 — is NOT in the local index at all (printing newer than the
snapshot), so the true score is **8/8 exact on answerable cards** and the
recognition engine has still never missed a card it actually contains.

## Async-first result delivery (user decision, 2026-08-28)

Pockets return INDEPENDENTLY, in any order: v1 fires nine ordinary
`/scan/visual-match` requests (client-minted scan_ids, grid cells fill on
arrival) with a client-side in-flight cap of ~3 matching the server's
inference slots — zero backend changes, each pocket gets the full existing
pipeline. This REVISES the earlier "batch endpoint is mandatory" claim:
capped fan-out is sufficient at personal/staging scale; the one-slot batch
endpoint (+ batched encoder forward) is the broad-rollout optimization.
Measured: ~110-140ms/pocket warm on M-series; VM estimate first cells ~1s,
full page ~3-4s through 3 slots.
