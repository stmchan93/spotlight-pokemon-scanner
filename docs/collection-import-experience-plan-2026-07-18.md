# Collection Import Experience — Guided Instructions, Result Summary & Graded Import

**Status:** Plan (not yet implemented). Date: 2026-07-18.
**Scope:** Polish the existing Collectr / TCGplayer CSV importer into a complete,
legible experience: guided export instructions, a post-import result summary, and
graded (slab) import support. All UI built from the existing design system.

---

## Context / Why

Migrating a collection from Collectr or TCGplayer is a real onboarding need. There
is **no account-sync API** for either service (TCGplayer's API is closed to new
devs; Collectr's API is catalog/pricing only and forbids scraping) — so **CSV
export → import is the only sanctioned path**, and it's the universal industry
standard (even Collectr's own TCGplayer importer is "email us a CSV"). Leading apps
(e.g. ManaBox) differentiate on three things, all cheap/OTA and cross-platform:

1. **Guidance** — telling the user *how* to get the CSV (the #1 confusion).
2. **A legible result** — import what matched, show what didn't and why.
3. **Coverage** — handle graded cards, not just raw.

The friction is *not* picking the file (the native picker already handles that on
iOS + Android). So this plan invests in guidance + legibility + graded coverage,
NOT in a share-target (which no competitor bothers with and which needs a native
rebuild — explicitly deferred, see Non-goals).

---

## Market validation (2026-07-18)

A r/PokemonTCG thread ("Pokémon collection app with actual Export/Import") surveyed
the market and confirms the gap is real and underserved:
- **Most apps have NO export/import** (Pokellector, Rare Candy, Pokecardex, pkmn.gg).
- **The ones that do, gate it:** Collectr **charges** to export the user's OWN data;
  Eyevo is **Apple-only**; TCGplayer's is a broken beta.
- The stated dream is exactly our combo: **"scan them in so I'm not typing"** + export
  to analyze / back up / switch apps ("set, number, card, variant, quantity, quality,
  comments").

Implications baked into this plan:
1. **Keep export FREE and make it PROMINENT** — surface it from the Collection screen,
   not only buried in Account. Direct wedge against Collectr's paywalled export. (Feat. 4)
2. **Android matters** — the thread explicitly complains Eyevo is Apple-only; our app
   now runs on Android (validated this session), answering that exact complaint.
3. **Add a per-card notes/comments field** — explicitly requested. (Feature 4)
4. Segment is **niche but vocal** (data-owners who recommend apps to others): cheap to
   serve, high trust/differentiation value. Do it well; don't over-invest.

---

## Current state (already built + shipped to staging)

The core pipeline works end to end and is reachable:

- **Front door:** "Import from TCGplayer / Collectr" buttons in the account screen →
  `pickAndStageImportFile` (`apps/spotlight-rn/src/features/portfolio-import/pick-import-file.ts`,
  `expo-document-picker` + `expo-file-system/legacy`) → the review screen.
- **Adapters:** `backend/import_source_adapters.py` parses `tcgplayer_csv_v1` and
  `collectr_csv_v1` (name/set/number/condition/variant/language/qty/cost + **graded
  columns already parsed**: `Grader`, `Grade`, `Cert`/`Certification Number` at
  `:199-201`).
- **Matching hierarchy** (`backend/portfolio_imports.py`): exact internal card id →
  `card_external_refs` (tcgplayer product id / collectr id) → exact name+set+number →
  ambiguous multi → fuzzy `search_cards()` shortlist → no match.
- **Endpoints:** `POST /api/v1/portfolio/imports/preview | /{job}/resolve | /{job}/commit`.
- **Review screen** (`.../portfolio-import/screens/portfolio-import-screen.tsx`, ~1.3k
  lines) already tracks per-row `matchState`
  (`review`/`unresolved`/`skipped`/`committed`/`unsupported`/`failed`) and running
  counts (`committedCount`, `unresolvedCount`, `skippedCount`, `unsupportedCount`).

**What's needed first:** real-CSV QA — run an actual Collectr and TCGplayer export
through it; matching quality shapes everything. Known gaps: Collectr parsing is
heuristic (columns vary); graded rows are blocked (see Feature 3).

---

## Feature 1 — Guided export instructions (small, OTA-safe, iOS+Android)

When the user taps "Import from Collectr/TCGplayer", show a short step screen BEFORE
the file picker.

```
Account → "Import from Collectr"
        ▼
┌─────────────────────────────┐
│  Import from Collectr        │  ← SectionHeader
│  1. Open Collectr            │  ← AppText (typography.body)
│  2. Portfolio → ••• → Export │
│  3. Save/Share the CSV       │
│  4. Come back & pick it      │
│  [ I've exported it → pick ] │  ← Button variant="dark"
│  [ Open Collectr ]  (opt.)   │  ← Button variant="outline" (deep link, best-effort)
└─────────────────────────────┘
```

- Content differs per `sourceType` (reuse/extend `portfolioImportSourceCopy` in
  `portfolio-import-file.ts`).
- "Pick" calls the existing `pickAndStageImportFile(sourceType)` → `/account/import`.
- Optional "Open <app>" deep link falls back to instructions if the app isn't installed.
- **Design system:** `SurfaceCard`, `SectionHeader`, `AppText` + `theme.typography`,
  `Button`, `useSpotlightTheme`. No ad-hoc styling.

**Files:** new instruction screen/component under `features/portfolio-import/`;
entry buttons in `features/auth/screens/account-screen.tsx` route through it.

---

## Feature 2 — Post-import result summary (small–medium, OTA-safe)

A simple completion screen after commit. The data already exists — this is
presentation over the counts the review screen maintains.

```
┌──────────────────────────────────────┐
│   ✓ Import complete            (StateCard success)
│   214  Added to your collection      │→ committed
│    12  Need review (multiple matches)│→ review     (tappable → filtered list)
│     8  Couldn't match                 │→ unresolved (tappable → why)
│     5  Graded — imported / not yet    │→ unsupported until Feature 3
│  ────                                 │
│   239  rows in your file              │
│   [ Review 12 unmatched ]  [ Done ]  │
└──────────────────────────────────────┘
```

**"Why" taxonomy** (maps 1:1 off existing `matchState`):

| Bucket | Meaning | Status |
|---|---|---|
| ✅ Added | matched + imported | `committed` |
| 🔶 Needs review | multiple candidates — pick one | `review` |
| ❌ Couldn't match | name/set/number not in catalog | `unresolved` / `no_local_match` |
| 🚫 Not supported | graded rows (until Feature 3 ships) | `unsupported` |
| ⏭ Skipped | user-skipped / duplicate | `skipped` |

- Each bucket is tappable → the already-existing filtered row list for that state.
- **Design system:** `SurfaceCard`, `AppText`/`theme.typography`, bucket rows as
  `PillButton`/rows using existing status tokens (`deltaUpSurface/Text`,
  `deltaDownSurface/Text`, gray scale) to match the app's count-chip treatment,
  `StateCard` for the success header, `Button` for actions.
- Optional (defer): "Download the unmatched rows as CSV" (ManaBox-style) — reuse the
  export CSV plumbing from the holdings-export feature.

**Files:** a summary view/state in `portfolio-import-screen.tsx` (the counts +
per-state filtering already exist).

---

## Feature 3 — Graded (slab) import (medium; the deliberate MVP gap)

**Why it's blocked today:** not a data or capability limit — a deliberate guard.
`portfolio_imports.py:525` marks any grader/grade/cert (or slab-token variant) row
`unsupported` ("slab-like rows are unsupported in this MVP"), and the commit path
**strips** grader/grade/cert (`:1061`). But the graded columns are already parsed,
card-matching is identical (still resolves the raw `card_id`), and the app fully
supports graded entries (slabContext, per-grade pricing, `SlabFrame`).

**What to change:**
1. Stop marking slab-like rows `unsupported`; instead resolve the card (same matcher)
   and carry the slab context through.
2. In commit, when a row is slab-like + resolved, **create a graded deck entry** with
   `slabContext = { grader, grade, certNumber, variantName }` (via the existing
   `create_deck_entry`/graded path) instead of stripping those fields at `:1061`.
3. Normalize graded inputs: grader (PSA/BGS/CGC/SGC), grade ("10","9.5"), and reuse
   `_sanitize_slab_variant_name` so the **grade label never leaks into `variant_name`**
   (the exact bug fixed in commit 55c7d04 — must not regress on import). Cert is
   optional metadata; identity is grader+grade+variant (+cert when present).
4. Review UI: render graded rows with **`SlabFrame`** (grader-branded) so they read as
   slabs, consistent with the collection.

**Care points (why it was deferred):** graded identity is stricter and the value
stakes are higher — a mis-imported "PSA 10" inflates portfolio value materially, and
graded pricing is per-grade/per-printing (the area we've been fixing). So: validate
grader/grade against known scales, drop rows with an unrecognized grade rather than
guess, and default cost-basis handling the same as raw.

**Files:** `backend/portfolio_imports.py` (slab branch + commit), possibly
`import_source_adapters.py` (grader/grade normalization), review row rendering in
`portfolio-import-screen.tsx`. Reuse: `deck_entry_storage_key`, the graded
`create_deck_entry` path, `SlabFrame`, `_sanitize_slab_variant_name`.

---

## Feature 4 — Per-card notes + free, prominent export (small)

Two small additions surfaced by the market signal above.

**Per-card notes/comments.** `deck_entries` has no note field today; add one:
- Backend: `deck_entries.note TEXT` (nullable) + accept/return it in the entry
  create/update payloads (`create_deck_entry` / `update_deck_entry_*`).
- Client: a notes field in the entry editor (design-system `TextField`), shown on the
  PDP inventory row.
- **Export:** add a `notes` column to the holdings CSV (`deck_entries_export_csv`).
- **Import:** map a "Comments"/"Notes" CSV column into the note when present
  (`import_source_adapters.py`).

**Free + prominent export.** Export is already built and ungated — keep it free, and
add an entry point on the **Collection screen** (not only Account settings), using the
existing `Button`/menu primitives. Message it as "own your data."

---

## Design system (required — `.claude/rules/rn-design-system.md`)

Everything is built from existing primitives; **no hand-rolled `fontSize`/
`fontWeight`/spacing/one-off shells**. Primitives used: `SurfaceCard`, `Button`
(variants `dark`/`outline`), `AppText` + `theme.typography` (`typography.control` for
button labels), `SectionHeader`, `PillButton`, `StateCard`, `SlabFrame`; color/spacing
via `useSpotlightTheme` tokens (incl. `deltaUp*`/`deltaDown*`). New shared bits, if
any, are added to the design system (prop-driven, documented in the DS README) rather
than styled inline in the screen.

---

## Recommended sequence

1. **Real-CSV QA of the raw importer** (already built) — see "How to QA" below. Measure
   match quality; fix adapter header aliases if columns differ. *This informs everything.*
2. **Feature 2** (result summary) — highest legibility win, data already there.
3. **Feature 1** (guided instructions) — kills "how do I export" confusion.
4. **Feature 4** (per-card notes + free/prominent export) — cheap, directly requested
   by the market signal.
5. **Feature 3** (graded import) — coverage; flip `unsupported` → real graded entries.
6. Onboarding placement ("Already track your collection somewhere? Bring it in").

---

## How to QA the importer (for the upcoming Collectr test)

Matching quality is the whole ballgame for Collectr (messy columns, heuristic adapter).
Test in this order:

1. **Get a real Collectr export** (only the user can): Collectr → Portfolio → Export
   CSV. Small but VARIED — ~30–50 cards: plain raw, a couple graded (PSA/BGS), a JP
   card, a promo, a tricky name (Farfetch'd / Nidoran♀ / Mr. Mime), a vintage 1st-Ed.
2. **Fast matching loop — `tools/qa_import_preview.py` (to build):** runs
   `parse_import_csv(collectr_csv_v1)` + the matcher against the real catalog and prints
   per-row `csv_name → matched card / status / why`. READ-ONLY (no commit), no auth/UI.
   This is where adapter header aliases get fixed (e.g. Collectr may call it "Item Name",
   not "Card Name").
3. **Full E2E on device/emulator:** `adb push collectr.csv /sdcard/Download/` → Account
   → Import from Collectr → pick → review → commit → verify in Collection. (Same via
   Files/AirDrop on iPhone.) Commits to the staging account (delete after if needed).
4. **Lock it in:** anonymize the real CSV into a fixture + a backend test so matching
   can't silently regress.

The pipeline is on staging now, so step 3 works today; steps 2 and 4 are small QA tools
worth building the moment a real CSV exists.

## Verification

- **Raw QA:** real Collectr + TCGplayer CSVs import; cost basis lands; spot-check
  matched rows in Collection.
- **Feature 2:** counts reconcile to file row count; each bucket taps to the right
  filtered list; empty/success states render.
- **Feature 3:** a graded CSV row (e.g. PSA 10) imports as a graded entry with correct
  grader/grade, `variant_name` is the print variant (NOT "PSA 10"), graded price shows
  on the PDP; unrecognized grades are dropped, not guessed. Add a backend test for the
  slab-commit path + `_sanitize_slab_variant_name` on import.
- `pnpm typecheck` + jest for the RN screens; `backend .venv/bin/pytest` for
  portfolio_imports; regenerate the Claude design bundle so DS usage doesn't drift.
- All features are **OTA-safe and cross-platform (iOS + Android)** — no native rebuild.

---

## Non-goals (deferred)

- **Share-target / "Open in Ekalight"** (export → Share → app). Needs a native rebuild
  (Info.plist / AndroidManifest intent-filters), and no competitor relies on it; the
  file picker already covers 100% of cases. Revisit only if users ask.
- Account-sync / scraping third-party logins (no API; ToS-violating; credential risk).
- "Download unmatched rows as CSV" — nice ManaBox-style follow-up, not required for v1.
