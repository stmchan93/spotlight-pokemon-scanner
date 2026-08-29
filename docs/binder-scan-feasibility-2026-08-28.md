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
