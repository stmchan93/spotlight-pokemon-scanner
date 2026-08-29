# Binder Scan v0 — implementation spec (test-the-scanner build)

**Goal:** a working binder-page mode on the phone — point at a 9-pocket page,
one tap, nine identified cards in the tray. Function over form: the UI is
deliberately minimal because the UX/visual pass is a separate effort (concept
mock: Figma "Binder Scan Concept", https://www.figma.com/design/jqMshTiPf4apLR0UnlOMd5).
Estimated **2–3 evenings**. Everything here rides on measured results in
`docs/binder-scan-feasibility-2026-08-28.md` (read it first).

## The one-paragraph design

Binder mode = a page-shaped reticle instead of the card reticle. The user
frames the page; the reticle IS the detector (the same philosophy the
single-card scanner already proved — no CV, no ML Kit in v0). On shutter:
capture at the highest available photo resolution, crop the reticle rect,
split into a 3×3 grid of pocket crops, normalize each to the standard
630×880, then fire **nine ordinary `/api/v1/scan/visual-match` requests**
(client-minted scan ids, max 3 in flight) whose results append to the
existing tray as nine normal rows, confirmed via the existing Add-All flow.
**Zero backend changes.**

## Have vs need

| | Have today | Need for v0 |
|---|---|---|
| Capture geometry | `makeReticleSourceImageCrop` + `buildNormalizedScannerTarget` (630×880 pipeline) | a page-aspect reticle rect + a 9-way subdivision of it |
| Resolution | preview-stream captures (HD iOS / FHD Android) | highest-res still in binder mode (see Open Question 1) |
| Matching | `/api/v1/scan/visual-match`, single image, game param | nothing — reuse as-is, nine times |
| Concurrency | server: 3 inference slots, 6s acquire timeout | client-side cap of 3 in-flight pocket requests |
| Results UI | tray `RecentCapture[]`, per-row candidates, tap-to-fix | nothing — nine rows appear; grid UI is the LATER UX pass |
| Bulk confirm | Add-All menu + `scan-bulk-confirm-sheet` + `handleBulkAddToCollection` | nothing |
| Persistence | per-scan schema (`scan_events` etc.), client-minted scan ids | nothing — nine scans are nine scans |
| Validation | `tools/binder_scan_poc.py` (reference implementation of split+match) | on-phone parity check against it |

## Implementation steps

### 1. Binder mode state + toggle (small)

- Add `captureMode: 'single' | 'page'` state to
  `apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx`.
- v0 toggle can be a plain button near the existing zoom dock / target pill —
  placement is throwaway (UX pass will move it).
- Page mode is Pokémon-lane-agnostic: it inherits the current `scanLane`
  exactly like single mode. No per-game work.

### 2. Page reticle (geometry only)

- Reticle layout lives in
  `src/features/scanner/components/raw-scanner-capture-surface.tsx`
  (`makeRawScannerCaptureLayout`, ~line 163; crop height derives from
  `rawCardReticleAspectRatio`).
- Add a page variant: aspect = (3·63)/(3·88) = **0.716 w/h** (same as a
  single card — a 3×3 page of cards has the card's aspect; convenient).
  Width ~92% of frame width (page fills more of the frame than a card does).
- Draw a faint 3×3 grid inside it (2 vertical + 2 horizontal hairlines at
  1/3 and 2/3) — pure decoration, but it doubles as the user's alignment
  guide, which is what makes reticle-as-detector work.

### 3. Capture → 9 crops (the core new code)

All in/next to `src/features/scanner/scanner-normalized-target.ts`:

- Today: `makeReticleSourceImageCrop` (~:118-156) maps the preview reticle
  rect → source-image pixel rect; `makeCanonicalCropRect` (~:83-116) force
  fits 630:880; `buildNormalizedScannerTarget` (~:158-259) does decode →
  rotate → crop → resize(630×880) → JPEG q0.82 → file URI.
- Add `buildBinderPocketTargets(sourceUri, reticleRect, ...)`:
  1. Map the PAGE reticle rect to source pixels (reuse the existing mapping
     math unchanged).
  2. Subdivide into 9 cells: cell(r,c) = pageRect offset by thirds, with a
     small inward inset per cell (~2% of cell width) so sleeve edges/gaps
     don't enter the crop. The backend POC used explicit GAP/BORDER because
     it composited pages; on a real photo plain thirds scored 8/8, so thirds
     + inset is the v0 rule (`tools/binder_scan_poc.py::split_page` is the
     reference).
  3. For each cell run the EXISTING canonical-crop + resize path → nine
     630×880 JPEGs. One full-res decode, nine crops — do not decode 9×.
- Keep the whole thing off the UI thread the same way the current normalize
  call is (see its call site in `handleCapture`, scanner-screen.tsx ~:1783).

### 4. Nine async scans, capped at 3 (the decision on record)

- Each pocket: mint `scanID` client-side exactly as today
  (`packages/api-client/src/spotlight/repository.ts` ~:5172,
  `createPseudoUUID`) and push a tray row immediately
  (`setRecentCaptures`, scanner-screen.tsx ~:1631; row shape
  `RecentCapture` in `scanner-screen-types.ts:15-38` — it already carries
  `isLoadingCandidates`, so nine loading rows render for free).
- Fire the visual-match calls through the existing repository scan method
  with a **concurrency cap of 3** (a ~10-line promise-pool; match the
  server's inference slots — un-capped nine WILL trip other users' 6s
  semaphore acquire timeouts). Results land per-row in arrival order —
  the async-per-pocket contract from the feasibility doc.
- Tag rows for analytics: add `captureBatchId` (one uuid per shutter tap)
  to the payload's client metadata if cheap; skip if it pulls in schema work
  — v0 does not need it.
- Empty pockets: v0 does NOTHING special. An empty sleeve comes back as a
  low-sim wrong match the user swipes away. Detection of empties is a UX-pass
  problem (cheap heuristic exists: crop variance + similarity floor).

### 5. Confirm flow

- Nothing to build: the tray's Add-All menu
  (`src/features/scanner/components/add-all-menu.tsx`,
  `scan-bulk-confirm-sheet.tsx`, `handleBulkAddToCollection`
  scanner-screen.tsx ~:2434) already bulk-adds every tray row sequentially.
  Nine binder rows are indistinguishable from nine single scans.

### 6. Artifacts

- v0: each pocket uploads its normalized crop through the existing deferred
  per-scan artifact path (repository.ts ~:5296-5305 defers until after match
  — keep that). The full-page source image is NOT uploaded in v0
  (`scan_artifacts.source_object_path` is per-scan; a page-level artifact is
  a schema change deliberately out of scope).

## Open questions (only two, both small)

1. **Still-capture resolution.** The capture-surface comment
   (raw-scanner-capture-surface.tsx ~:303-313) documents that today's crops
   come from HD (iOS) / FHD (Android) frames. Binder pockets at those
   resolutions are 240–360px — measured acceptable (76–91% top-1) but the
   fix is nearly free: in page mode take the photo at max sensor resolution
   (vision-camera `takePhoto` supports formats beyond the preview stream).
   At 4K a pocket is ~720px → above-native → zero accuracy cost. Implement
   if it's a format flag; if it turns into a capture-pipeline rework, ship
   v0 at current resolution (the measurements say it works) and note it.
2. **Rotation.** Binder photos are portrait-page; confirm the existing
   rotate-then-crop path in `buildNormalizedScannerTarget` behaves with the
   page reticle on both platforms (Android EXIF rotation is the usual
   suspect — see the existing rotate handling ~:158-259).

## Validation (definition of done)

1. **Parity harness first:** feed the SAME photo to the app path and to
   `tools/binder_scan_poc.py --page` — pocket crops should match closely and
   top-1 ids should agree. The POC is the reference implementation; disagreement
   means the RN crop math drifted.
2. **The real page:** the user's binder page (8/8 exact printings on
   in-index cards) must reproduce on-phone.
3. **Latency:** first tray row < ~2s, ninth row < ~6s against the Mac dev
   backend on LAN (VM adds ~1s/pocket; fine).
4. **Single-card mode untouched:** existing scanner tests green
   (`__tests__/scanner-screen-test.tsx` etc.), plus a couple of new unit
   tests for the 9-way subdivision math (pure function — test cell rects sum
   to the page rect, insets applied, aspect preserved).

## Explicitly out of scope for v0 (the UX pass owns these)

Grid review sheet + page-value rollup (Figma concept exists), empty-pocket
detection, per-cell honest-miss copy, quad detection for sloppy framing,
batch endpoint + INT8 (broad-rollout capacity), page-level artifact schema,
mixed-game pages.

## Context docs

- Feasibility + all measurements: `docs/binder-scan-feasibility-2026-08-28.md`
- Reference implementation of split+match: `tools/binder_scan_poc.py`
- Capacity background: `docs/backend-capacity-load-test-2026-07-01.md`
- Why reticle-not-detector: `docs/scanner-live-lock-on-ux-spec-2026-05-21.md`
  (and note its deferral logic does NOT apply here — see feasibility doc)
