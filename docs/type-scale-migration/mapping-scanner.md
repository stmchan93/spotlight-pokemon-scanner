# Type-scale mapping — Scanner (Figma page "2. Scanner", 1041:3486)

Phase-1 inventory, 2026-10-18. Read-only. Figma file `XRUD89H31ESUrvf9fGMtjW`.
Code paths are relative to `apps/spotlight-rn/src/features/scanner/`. Token metrics from
`code-text-roles.json` (e.g. `headline` = SemiBold 16/21.6, `labelStrong` = SemiBold 13/18.2,
`label` = Medium 13/18.2, `caption` = Medium 12/16, `overline` = Medium 11/14.3, `body` = Regular 15/20,
`bodyLarge` = Regular 16/21.6, `control`/`bodyStrong` = SemiBold 15/20, `titleSmall` = SemiBold 17/22.95).

Frames pulled with `get_design_context`: 5753:17489 (Scan-1, tray expanded, 8 rows), 5753:18117 (Change
Card), 5753:18692 (Scanner Settings), 5768:19601 (Bulk actions / Expand modal - 8 scans + confirm),
3594:25305 (Peak-10%), 1041:5286 (Full-85%), 5768:20614 (Side-swipe footer), 5708:19468 (9-card).
`get_metadata` on 5766:18930 confirmed every "Expand modal - 8 scans" frame is the same expanded tray.
Small-23% (1041:5261) shares Full-85%'s elements; not pulled separately.

**Figma reality on this page:** only Title-small (SemiBold 17), Label (Medium 14), Overline (Regular 12),
Caption (Regular 13) and Caption-medium (Medium 13) are applied. Everything SemiBold 13, Medium 10 and
Medium 12 is raw. The same element flips between raw and styled across sibling frames (see
"Figma inconsistencies" at the end).

Actions: `ok` | `change-role → <FigmaStyle>` | `hardcoded → tokenize` | `raw-in-figma` (designer
decision) | `missing-in-figma` | `missing-in-code`.

## 1. Scan-1 tray row + info header (Peak-10% / Small-23% / Full-85%, Scan section)

Rendered by `screens/scanner-screen.tsx` (`renderRecentCapture`, tray header ~5070-5210) via
`screens/scan-tray-list.tsx` (layout only, no text styles of its own).

| element | Figma style (or raw metrics) | code role today | file:line | action |
|---|---|---|---|---|
| Card name "Ludicolo" | Title-small SemiBold 17 | `textStyles.headline` (SemiBold 16) | scanner-screen.tsx:5840 `captureTitle` | change-role → Title-small |
| Set line "038/088 · Perfect Order" | Label Medium 14 | `caption` + override bodyMedium 13 / lh 16.4 | scanner-screen.tsx:5717-5723 `captureSubtitle` | change-role → Label; hardcoded → tokenize (drop the 3 overrides) |
| Lane line "RAW" | Label Medium 14 | `textStyles.caption` (Medium 12) | scanner-screen.tsx:5668 `captureMeta` | change-role → Label |
| Price "$0.15" | Title-small SemiBold 17 | `textStyles.headline` | scanner-screen.tsx:5684 `capturePriceValue` | change-role → Title-small |
| ADD pill label ("ADD ITEM" in code) | raw SemiBold 13, lh 1.4 (=18.2) | raw bodySemiBold 13 / 18.2 | scanner-screen.tsx:5872-5877 `captureAddPillLabel` | raw-in-figma; hardcoded → tokenize to `labelStrong` (identical metrics) |
| CHANGE thumbnail chip | raw Medium 10 (one row on 17489 shows Regular 12 purple "Change") | raw bodyMedium 11 / 14.3 | scanner-screen.tsx:5822-5827 `captureChangeLabel` | raw-in-figma (10 vs 11 vs 12 — designer picks; code could use Overline 12) |
| Graded ref chip (PSA 10 etc.) | — | raw bodyMedium 11 / 14.3 | scanner-screen.tsx:5828-5839 `captureGradedRefChip` | missing-in-figma; tokenize with CHANGE chip |
| Printing pill (purple "Reverse Holofoil") | — (only in Change Card as Medium 12 option chips) | `labelStrong` + fontSize 12 | scanner-screen.tsx:5746-5751 `capturePrintingLabel` | missing-in-figma; hardcoded → tokenize |
| "SCAN: N" pill | SemiBold 13 raw on 17489/19601 Full; Medium 13 (Caption-medium) on Peak/Small/18117/20614 | `textStyles.labelStrong` | scanner-screen.tsx:5902 `trayInfoPillLabel` | raw-in-figma (weight disagrees across frames) |
| "TOTAL: $…" pill | same as SCAN pill | `labelStrong` | scanner-screen.tsx:5902 (same style) | raw-in-figma |
| Discount tag next to total | — | `labelStrong` | scanner-screen.tsx:5911 `trayDiscountTag` | missing-in-figma |
| "ADD ALL" (purple, header) | raw SemiBold 13 purple500 | `labelStrong` | scanner-screen.tsx:5928 `trayAddAllLabel` | raw-in-figma |
| "CLEAR ALL" (red outline pill) | Label Medium 14 red500 | `textStyles.label` (Medium 13) | scanner-screen.tsx:5954 `trayClearAllLabel` | change-role → Label |
| Empty / failure / "Finding match" rows | — | `captureTitle` / `captureSubtitle` | scanner-screen.tsx:694-704, 777-778 | missing-in-figma (inherit the row mapping) |

## 2. Top chrome: toolbar target pill, zoom dock, mode pill

| element | Figma style (or raw metrics) | code role today | file:line | action |
|---|---|---|---|---|
| Toolbar "POKEMON EN" pill | Label Medium 14 gray900 | `textStyles.bodyLarge` (Regular 16) | components/scan-target-pill.tsx:59-60 `label` | change-role → Label (biggest visible delta on the page) |
| Mode pill "SINGLE" | Medium 13 (Caption-medium on 18117/18692/20614/19468, raw on 17489); "Single" Medium 14 on 19601 | `labelStrong` + fontSize 12 | scanner-screen.tsx:5611-5617 `binderModePillLabel` | raw-in-figma (13 vs 14, Medium vs code SemiBold); hardcoded → tokenize |
| Zoom factor "1x / 1.5x / 2x" | Medium 13 (Caption-medium / raw); Medium 14 on 19601 | `labelStrong` + fontSize 12 | scanner-screen.tsx:5644-5649 `zoomPillLabel` | raw-in-figma; hardcoded → tokenize (likely Caption-medium) |
| Scan prompt over the reticle | — (Scan-0 frame 1041:4238 referenced by design-map.json no longer exists) | `textStyles.headline` | raw-scanner-capture-surface.tsx:907-908 `scanPrompt` | missing-in-figma |
| Language tooltip "Switch games and languages!" | — | raw bodyRegular 15 / 20 | components/scanner-language-tooltip.tsx:114-118 `copy` | missing-in-figma; hardcoded → tokenize (`body`) |
| Camera-denied card title / body / button | — | `labelStrong` / `caption` / `labelStrong` | scanner-screen.tsx:5782, 5787, 5801 | missing-in-figma |

## 3. Side-swipe footer (5768:20614)

| element | Figma style (or raw metrics) | code role today | file:line | action |
|---|---|---|---|---|
| "Collection" / "Delete" under the round buttons | Overline Regular 12 white | `textStyles.overline` (Medium 11) | screens/recent-capture-swipe-row.tsx:250-251 `captureActionLabel` | ok once `overline` is re-cut to Regular 12 |
| Row content | same as section 1 | same | — | — |

## 4. Change Card picker (5753:18117) — `screens/change-card-picker.tsx`

| element | Figma style (or raw metrics) | code role today | file:line | action |
|---|---|---|---|---|
| Header pill "CHANGE" | Overline Regular 12 | raw 'SpotlightBodySemiBold' 13 / 18.2 | change-card-picker.tsx:605-609 `infoPillText` (used :354) | hardcoded → tokenize; change-role → Overline (or keep SemiBold 13 = Figma "12 SIMILAR"; designer decision) |
| Header pill "12 SIMILAR" | raw SemiBold 13 | same `infoPillText` | :357 | raw-in-figma; tokenize to `labelStrong` |
| Hero captions "YOUR PHOTO" / "71% MATCH" | Overline Regular 12 (green300 for match) | raw 'SpotlightBodySemiBold' 13 | :628-631 `heroCaption` (used :372, :404) | hardcoded → tokenize; change-role → Overline |
| Candidate name "Arven's Greedent" | Title-small SemiBold 17 | raw 'SpotlightBodySemiBold' 16 / 21.6 | :705-709 `rowTitle` (used :464) | hardcoded → tokenize; change-role → Title-small |
| Candidate meta "159/182 · Destined Rivals" + "RAW" | Label Medium 14 gray400 | raw 'SpotlightBodyMedium' 13 / 18.2 | :711-715 `rowMeta` (used :468) | hardcoded → tokenize; change-role → Label |
| Variant option chips "Normal / Reverse Holofoil" | raw Medium 12 | `PillButton tone="option"` → `typography.caption` (Medium 12) | :485-493; pill-button.tsx:69 | ok metrically; raw-in-figma |
| "LOAD MORE" outline pill | Label Medium 14 purple300 | raw 'SpotlightBodyMedium' 13 / 18.2 | :742-746 `loadMoreLabel` (used :521) | hardcoded → tokenize; change-role → Label |

All five `fontFamily: 'Spotlight…'` string literals in this file bypass `fontFamilies` entirely.

## 5. Scanner Settings / "SCANNING FOR" sheet (5753:18692) — `components/scanning-for-sheet.tsx`

| element | Figma style (or raw metrics) | code role today | file:line | action |
|---|---|---|---|---|
| Header pill "SCANNING FOR" | raw SemiBold 13 | `AppText variant="labelStrong"` | scanning-for-sheet.tsx:123 | raw-in-figma (matches code metrics) |
| Game rows "POKEMON EN" … | Caption Regular 13 white | `AppText variant="body"` (Regular 15) | :220 | change-role → Caption |
| Disabled rows "MAGIC THE GATHERING" | Caption Regular 13 gray600 | `AppText variant="body"` | :233 | change-role → Caption |
| "COMING SOON" tag | Overline Regular 12 gray400 | `AppText variant="overline"` (Medium 11) | :237 | ok after overline re-cut |

## 6. Bulk actions (5766:18930, 5768:19323/19601/19913/20178 + Footer-modal-expanded 1821:7145, 5938:12356/12365)

The "Expand modal - 8 scans" frames are the expanded tray from section 1 (same rows, same header) plus
the add-all confirm dialog. There is no Figma frame for the binder batch editor (section 7).

| element | Figma style (or raw metrics) | code role today | file:line | action |
|---|---|---|---|---|
| Confirm title "Add 8 items to Collections?" | raw SemiBold 13 | `typography.titleSmall` (17) | components/scan-bulk-confirm-sheet.tsx:134 | raw-in-figma (Figma 13 looks like a mistake; code's Title-small is the sane choice — confirm with designer) |
| Confirm body "THESE ITEMS WILL BE ADDED…" | Caption Regular 13 | `typography.body` (15) | scan-bulk-confirm-sheet.tsx:141 | change-role → Caption |
| Buttons "ADD ALL" / "CANCEL" | Label Medium 14 | `Button size="md"` → `labelStyleVariant` default `control` (SemiBold 15) | scan-bulk-confirm-sheet.tsx:155-172; button.tsx:72-79 | change-role → Label (Button primitive default; cross-area) |
| Add-all dropdown menu rows | — | `typography.body` | components/add-all-menu.tsx:135,153,171 | missing-in-figma |
| Printing / binder-layout menus | — | `typography.body` | components/printing-menu.tsx:189, binder-layout-menu.tsx:121 | missing-in-figma |
| Custom discount sheet title / "%" | — | `titleSmall` / `body` | components/custom-discount-sheet.tsx:70, 92 | missing-in-figma |

## 7. 9-card scanner (5708:19468), binder page header, binder review (batch editor)

The 9-card Figma frame adds only the 3x3 grid lines; its tray and chrome are section 1/2. No text.

| element | Figma style (or raw metrics) | code role today | file:line | action |
|---|---|---|---|---|
| Tray page header "BINDER PAGE · 9 CARDS" | — | raw bodyMedium 12 / 16, letterSpacing 0.6 | scanner-screen.tsx:5529-5536 `binderPageHeaderLabel` (used :4569) | missing-in-figma; hardcoded → tokenize (Overline + tracking?) |
| "VIEW PAGE" / delete buttons in that header | — | raw bodyMedium 11 / 14 | :5555-5560 `binderPageHeaderButtonLabel` (used :4588, :4607) | missing-in-figma; hardcoded → tokenize |
| "Pocket N" badge on rows | — | raw bodyMedium 11 / 14 | :5581-5587 `pocketBadgeLabel` (used :515) | missing-in-figma; hardcoded → tokenize |
| Binder review title "Binder page" | — | `textStyles.headline` | screens/binder-page-review.tsx:583-584 `title` | missing-in-figma |
| Binder review subtitle / hint | — | `caption` + fontFamily bodyMedium | :587-590 `subtitle` | missing-in-figma; hardcoded → tokenize |
| Pocket number on tile | — | raw bodyMedium 11 / 14 | :650-654 `pocketNumberLabel` | missing-in-figma; hardcoded → tokenize |
| Tile caption name | — | raw bodyMedium 12 / 15 | :660-664 `captionTitle` | missing-in-figma; hardcoded → tokenize |
| Tile caption set line | — | raw bodyRegular 10 / 13 | :666-670 `captionMeta` | missing-in-figma; hardcoded → tokenize (below any Figma size) |
| Tile price | — | raw bodySemiBold 12 / 15 | :711-716 `captionPrice` | missing-in-figma; hardcoded → tokenize |
| Tile printing / select tick | — | `textStyles.overline` | :679-680, :703-704 | missing-in-figma |
| Batch row "Variant" dropdown / "Done" | — | `labelStrong` + fontSize 12 / 13 | components/binder-batch-action-row.tsx:161-164, 190-194 | missing-in-figma; hardcoded → tokenize |
| Footer "Add N · $…" | — | `Button size="lg"` → `control` | binder-page-review.tsx:373-377 | missing-in-figma |

## 8. Code-only surfaces (no Figma frame on this page)

| surface | roles | file:line |
|---|---|---|
| Scan price sheet (tap price/printing) | `headline` close glyph (+ lineHeight 20), `bodyStrong` rowTitle, `caption` rowSubtitle/disclaimer, `headline` rowPrice, `control` link labels | screens/scan-price-sheet.tsx:265, 425-429, 441-442, 484-498 |
| Matches panel (legacy) | `control` title, `caption` meta, `bodyStrong` price/title | scanner-screen.tsx:5977-5992, 6013-6016 |

## Hardcoded font literals outside tokens.ts (area files)

| file:line | literal | note |
|---|---|---|
| screens/change-card-picker.tsx:607-609 | fontFamily 'SpotlightBodySemiBold', fontSize 13, lineHeight 18.2 | `infoPillText` = labelStrong |
| screens/change-card-picker.tsx:630-631 | fontFamily 'SpotlightBodySemiBold', fontSize 13 | `heroCaption`, no lineHeight |
| screens/change-card-picker.tsx:707-709 | fontFamily 'SpotlightBodySemiBold', fontSize 16, lineHeight 21.6 | `rowTitle` = headline |
| screens/change-card-picker.tsx:713-715 | fontFamily 'SpotlightBodyMedium', fontSize 13, lineHeight 18.2 | `rowMeta` = label |
| screens/change-card-picker.tsx:744-746 | fontFamily 'SpotlightBodyMedium', fontSize 13, lineHeight 18.2 | `loadMoreLabel` = label |
| screens/scanner-screen.tsx:5531-5534 | fontFamily bodyMedium, fontSize 12, letterSpacing 0.6, lineHeight 16 | `binderPageHeaderLabel` |
| screens/scanner-screen.tsx:5557-5559 | fontFamily bodyMedium, fontSize 11, lineHeight 14 | `binderPageHeaderButtonLabel` |
| screens/scanner-screen.tsx:5583-5585 | fontFamily bodyMedium, fontSize 11, lineHeight 14 | `pocketBadgeLabel` |
| screens/scanner-screen.tsx:5616 | fontSize 12 (over labelStrong) | `binderModePillLabel` — lineHeight stays 18.2 |
| screens/scanner-screen.tsx:5649 | fontSize 12 (over labelStrong) | `zoomPillLabel` |
| screens/scanner-screen.tsx:5720-5722 | fontFamily bodyMedium, fontSize 13, lineHeight 16.4 (over caption) | `captureSubtitle` |
| screens/scanner-screen.tsx:5750 | fontSize 12 (over labelStrong) | `capturePrintingLabel` |
| screens/scanner-screen.tsx:5824-5826 | fontFamily bodyMedium, fontSize 11, lineHeight 14.3 | `captureChangeLabel` |
| screens/scanner-screen.tsx:5833-5835 | fontFamily bodyMedium, fontSize 11, lineHeight 14.3 | `captureGradedRefChip` |
| screens/scanner-screen.tsx:5874-5876 | fontFamily bodySemiBold, fontSize 13, lineHeight 18.2 | `captureAddPillLabel` = labelStrong |
| screens/binder-page-review.tsx:590 | fontFamily bodyMedium (over caption) | `subtitle` |
| screens/binder-page-review.tsx:652-654 | fontFamily bodyMedium, fontSize 11, lineHeight 14 | `pocketNumberLabel` |
| screens/binder-page-review.tsx:662-664 | fontFamily bodyMedium, fontSize 12, lineHeight 15 | `captionTitle` |
| screens/binder-page-review.tsx:668-670 | fontFamily bodyRegular, fontSize 10, lineHeight 13 | `captionMeta` |
| screens/binder-page-review.tsx:714-716 | fontFamily bodySemiBold, fontSize 12, lineHeight 15 | `captionPrice` |
| screens/scan-price-sheet.tsx:426 | lineHeight 20 (over headline) | `closeGlyph` |
| components/scanner-language-tooltip.tsx:116-118 | fontFamily bodyRegular, fontSize 15, lineHeight 20 | `copy` = body |
| components/binder-batch-action-row.tsx:164 | fontSize 13 (over labelStrong, no-op) | `doneLabel` |
| components/binder-batch-action-row.tsx:194 | fontSize 12 (over labelStrong) | `pillLabel` |

No `fontWeight:` literals in the area. `scan-tray-list.tsx`, `round-flag.tsx`, `scan-target-pill.tsx`,
`scanning-for-sheet.tsx`, the three menus and the confirm/discount sheets have none.

## Role → Figma style summary (scanner area)

Role usage in the area (grep): `labelStrong` 13, `caption` 7, `headline` 6, `body` 7, `bodyStrong` 3,
`control` 2, `overline` 4, `label` 1, `titleSmall` 2, `bodyLarge` 1.

| code role | Figma style here | note |
|---|---|---|
| `headline` (SemiBold 16) | **Title-small** (SemiBold 17) | card name, price, picker row title |
| `labelStrong` (SemiBold 13) | **none** — raw SemiBold 13 everywhere | ADD, SCAN/TOTAL, ADD ALL, 12 SIMILAR, SCANNING FOR. The scanner's most-used role has no library style; either the designer adds "Label-strong SemiBold 13" or these become Caption-medium/Label |
| `label` (Medium 13) | **Label** (Medium 14) | CLEAR ALL |
| `caption` (Medium 12) on tray meta | **Label** (Medium 14) | set line, RAW line — Figma makes them a full size step bigger than `caption` |
| `caption` elsewhere (denied body, price-sheet subtitle) | **Caption** (Regular 13) | weight flips Medium → Regular |
| `overline` (Medium 11) | **Overline** (Regular 12) | swipe labels, COMING SOON, picker captions |
| `bodyLarge` (Regular 16) | **Label** (Medium 14) | toolbar target pill only |
| `body` (Regular 15) | **Caption** (Regular 13) | settings rows, confirm body; menus have no frame |
| `control` (SemiBold 15, Button default) | **Label** (Medium 14) | confirm buttons — Button primitive default is cross-area |
| `titleSmall` | Title-small | confirm/discount titles (Figma frame shows raw 13, see below) |
| raw Medium 10/11 chips | raw Medium 10 in Figma | CHANGE chip; nothing in the 11-style scale is that small |

## Figma inconsistencies to raise

1. SCAN/TOTAL pills: SemiBold 13 (17489 expanded, 19601, Full-85%) vs Medium 13 (Peak-10%, 18117, 18692,
   20614, 19468). Same component, two weights. Code uses SemiBold.
2. Mode pill + zoom factors: Medium 13 on every Scan-1 frame, Medium 14 ("Single") on Expand modal 19601.
3. CHANGE thumbnail chip: Medium 10 gray700 on most rows, but two rows on 17489 and one on Full-85% use
   Regular 12 purple500 "Change" — looks like a half-applied redesign.
4. Caption-medium is listed in the style footer of 18117/18692/20614/19468 but not 17489/19601, i.e.
   the same Medium 13 texts are styled on some frames and raw on others.
5. "Add 8 items to Collections?" confirm title is raw SemiBold 13 — smaller than its own body copy's
   13 Regular would suggest for a title; code uses Title-small.
6. Picker header pill "CHANGE" is Overline (Regular 12) while its sibling "12 SIMILAR" is SemiBold 13.
7. design-map.json still points the Scan-0 alternate at 1041:4238, which no longer exists in the file.
8. Nothing on this page uses Body / Body-medium / Body-large / Title-medium / Display / Title-large; the
   scanner is a Title-small + Label + Overline + Caption page with ~40 raw SemiBold 13 / Medium 10 texts.
