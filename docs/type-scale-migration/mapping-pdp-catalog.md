# Mapping — PDP + Catalog (phase-1 inventory, 2026-10-18)

Area: Figma page "4. Product Details Page" (863:5181) + section "Profile - PDP" on page 1. Code:
`apps/spotlight-rn/src/features/cards/**` and `apps/spotlight-rn/src/features/catalog/**`.
Paths below are relative to `apps/spotlight-rn/src/features/` unless prefixed. Read-only; no source touched.

Dev routes: `spotlight://dev/card-detail` (sm7-1), `dev/card-detail-owned`, `dev/card-detail-sealed`,
`dev/price-trend-graded` (registry `apps/spotlight-rn/src/dev/dev-screen-host.tsx:63-78`).

## Alias assumptions used in the "action" column

"ok" means the code role's natural alias (phase 2) lands on the Figma style; it does NOT mean the
pixels match today. Aliases assumed for roles that appear in this area:

| code role (today) | → Figma style | note |
|---|---|---|
| display (ExtraBold 36, display family) | Display (Bold 29) | catalog titles; weight family change |
| titleLarge 22 / titleMedium 18 / titleSmall 17 | Title-large 23 / Title-medium 19 / Title-small 17 | 1:1 |
| headline (SemiBold 16) | Title-small | no Figma 16 SemiBold; nearest |
| body (Regular 15) | Body (14) | PDP frames still show 15 |
| bodyMedium (Medium 14) | Body-medium (14) | PDP frames show 15 (stale library) |
| bodyStrong (SemiBold 15) | — none | Product-details inline label is unstyled Bold 15 in Figma |
| label (Medium 13) | Label (Medium 14) | every Figma site code calls `label` is Label 14 (chips, buttons, counts); 13-pt Medium sites must move to Caption-medium |
| labelStrong (SemiBold 13) | — none | Figma uses unstyled SemiBold 13 for sheet headers; nearest Caption-medium |
| captionMedium (Medium 12) | Caption-medium (Medium 13) | |
| caption (Medium 12) | Caption (Regular 13) | weight flips Medium→Regular |
| overline (Medium 11) | Overline (Regular 12) | |
| control (SemiBold 15) / micro (SemiBold 11) | Label / Overline | only via SectionHeader / ScreenHeader primitives |
| title (display 25) | Title-medium | SectionHeader non-compact title |

## Figma frames used

| screen/state | frame(s) pulled | notes |
|---|---|---|
| Graded PDP | 5768:21988 (1816 tall; sections 5768:22443, :22061, :22085, :22030, 5938:2632, :22003, :22054, :22162) | OLD library: Body 15, Body-medium 15, Option Title = Label uppercase, chips = Caption 13, section titles unstyled Medium 16 |
| Graded PDP (newer) | 5768:22713 (sections 5768:22721, :22807); 5753:10734 | NEWER: Option Title = Title-small 17, chips = Label 14, "Price Trend"/"Product Details" = Title-medium 19, sentence case |
| Profile-PDP (owned) | 5938:25164, 5938:25794 (Frame 161 instance 5938:25303 / :25933 = Inventory dropdown) | same old mix + Caption-medium 13 "INVENTORY" |
| Raw PDP | 5768:23400 (sections 5768:23493, :23621); 5768:23886 Condition (sections 5768:24000, :24117) | condition rows Caption 13 (old) vs Body 15 (Condition frame) |
| Grade picker sheet | 1640:6013 | selected row unstyled SemiBold 14; rest Body 15 |
| Condition picker sheet | 1664:2595, 5768:24117 | selected Label 14; rest Body 15 (1664) / Caption 13 uppercase (5768:24117) |
| Add-to-collection sheet | 4211:84974, 5938:7376 | Label titles uppercase, Caption chips, Title-medium quantity, Body cost-basis placeholder |
| Confirm delete sheet | 5938:20747 (inside 5753:10734) | Caption warning copy, Label button, unstyled SemiBold 13 header |
| Catalog search / browse sets / game sets / expansion detail | **none in inventory** | mapped by metrics only (see §Catalog) |
| Scan candidate review (`cards/screens/scan-candidate-review-screen.tsx`) | none on this page ("Change Card" lives on page 2, other agent) | hardcoded literals recorded in §4 |

## 1. Graded PDP (5768:21988 old / 5768:22713 new / 5938:25164 Profile-PDP)

| element | Figma style (frame shows) | code role today | file:line | action |
|---|---|---|---|---|
| Sticky header card name | Title-medium SemiBold 19 | typography.titleMedium | cards/screens/card-detail-screen.tsx:3086 | ok |
| Card name (identity) | Title-large Bold 23 | titleLarge | card-detail-screen.tsx:2788 | ok |
| "51/64 · Neo Revelation" | Body-medium (Medium 15, canonical 14) gray600 | bodyMedium | card-detail-screen.tsx:2793 | ok |
| "Jun 10, 2000 · Illus. …" | Body-medium | bodyMedium | card-detail-screen.tsx:2801 | ok |
| Wishlist count "10.1k" (Notification Count) | Label Medium 14 gray600 | label (13) | cards/components/card-wishlist-counter.tsx:34 | ok (alias → Label 14) |
| Since-added amount "+$12.40" | — not on any PDP frame | hardcoded SemiBold 14/21 (`styles.sinceAddedAmount`) | card-detail-screen.tsx:3311-3313 | hardcoded → tokenize (Label-weight sibling; missing-in-figma) |
| Since-added caption | — | captionMedium | card-detail-screen.tsx:2823 | missing-in-figma (→ Caption-medium) |
| "You're watching the …" + underlined printing links | — | captionMedium (+ `watchingPrintingLink` underline) | card-detail-screen.tsx:2834, :2841 | missing-in-figma (→ Caption-medium) |
| Option group title "Language/Variant/Grader" | old: Label 14 UPPERCASE · new 5768:22784/5768:24002: **Title-small 17** sentence case | titleSmall | cards/components/card-configurator.tsx:79 | ok vs newer frames; old frames stale |
| Option chip "EN / Holofoil / PSA" | old: Caption Regular 13 · new 5768:24005: **Label Medium 14** | label (13 Medium) | card-configurator.tsx:67 | ok vs newer (alias → Label 14) |
| Inventory header "INVENTORY" (Frame 161) | Caption-medium Medium 13, uppercase | AppText variant="bodyMedium" "Inventory" | cards/components/inventory-dropdown.tsx:98 | change-role → Caption-medium (and casing differs) |
| Inventory row summary "NM · HOLOFOIL · EN ·" | Caption-medium 13 | AppText variant="label" | inventory-dropdown.tsx:144 | change-role → Caption-medium (label will grow to 14) |
| Inventory row qty "2" | Label 14 | label | inventory-dropdown.tsx:150 | ok |
| Inventory row price "$400.85" | Body-medium 15 (→14) | bodyMedium | inventory-dropdown.tsx:183 | ok |
| Inventory row cost basis "$100.10" | Label 14 gray600 | label | inventory-dropdown.tsx:190 | ok |
| Inventory delta pill "$300.16" | Label 14 green600 | label | inventory-dropdown.tsx:216 | ok |
| "PRICE TREND" / "Price Trend" title | old: unstyled Medium 16 · new 5768:22809: **Title-medium 19** | titleMedium | cards/components/card-price-trend-list.tsx:67 | ok vs newer |
| Price-trend skeleton title "Price Trend" | Title-medium | titleSmall | cards/components/card-price-trend-skeleton.tsx:69 | change-role → Title-medium (inconsistent with live list) |
| Price row grade label "PSA 10" | Body Regular 15 gray700 (canonical 14) | body + `styles.gradeLabel` {fontSize 14, lineHeight 21} | card-price-trend-list.tsx:101, :216-217 | hardcoded → tokenize (override becomes dead once Body = 14/18) |
| Price row price "$450.016" | Body-medium 15 (→14) | bodyMedium | card-price-trend-list.tsx:124 | ok |
| Pop Report title "POP REPORT" | unstyled SemiBold 14 | — | — | missing-in-code |
| Pop Report cell title "PSA TOTAL / 10 / 9" | Overline Regular 12 | — | — | missing-in-code |
| Pop Report cell value "21,6850" | Body-medium 15 | — | — | missing-in-code |
| "Product Details" title | old 5938:2634: unstyled Medium 16 UPPERCASE · new 5768:22722: **Title-medium 19** | titleMedium | cards/components/card-product-details.tsx:101 | ok vs newer |
| Product detail label "Card Number / Rarity:" | unstyled **Bold 15** span inside Body paragraph (no library style) | bodyStrong (SemiBold 15) | card-product-details.tsx:109 | missing-in-figma (raise: needs a Body-bold style or stays local override) |
| Product detail value | Body 15 #717171 | body (textSecondary) | card-product-details.tsx:106 | ok |
| Similar cards title | — (no Figma section) | AppText titleMedium | cards/components/card-similar-section.tsx:131 | missing-in-figma (→ Title-medium) |
| "Goes with" / subtitle | — | AppText titleSmall / captionMedium | card-similar-section.tsx:136-137 | missing-in-figma |
| Footer SAVE / CANCEL / UPDATE / SHARE | Label Medium 14 (button "Secondary" 5768:22163) | Button labelStyleVariant="label" → typography.label (13) | card-detail-screen.tsx:3150-3190; DS `components/button.tsx:78` | ok (alias → Label 14) |
| Loading "Loading card..." / "Card unavailable" + copy | — | headline / body | card-detail-screen.tsx:2739, :2749-2750 | missing-in-figma (→ Title-small / Body) |

Owned-entry edit block (Profile-PDP "Delete: Edit" states; same fields as the Add-to-collection sheet §3):

| element | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| Group titles "Grade / Quantity / Cost Basis" | Label 14 UPPERCASE (4211:84974, old) — newer PDP frames use Title-small for sibling option groups | titleSmall | cards/components/owned-entry-edit-fields.tsx:67, :89, :129 | ok vs newer convention; sheet frame stale |
| Grade selector value "SELECT" | Caption Regular 13 | label (Medium 13) | owned-entry-edit-fields.tsx:80 | change-role → Caption |
| Quantity value "1" | Title-medium SemiBold 19 | titleMedium | owned-entry-edit-fields.tsx:108 | ok |
| Cost-basis "$" prefix + TextInput | Body Regular 15 gray400 placeholder | bodyMedium (lineHeight stripped) | owned-entry-edit-fields.tsx:145, :159 | change-role → Body (weight Medium→Regular) |
| Gain pill "+$300.16" | Label 14 | label | owned-entry-edit-fields.tsx:174 | ok |
| "Updated …" stamp | — | overline | owned-entry-edit-fields.tsx:179 | missing-in-figma (→ Overline) |

## 2. Raw PDP (5768:23400 / 5768:23886 Condition)

Identity, options, product details, footer: identical to §1 (same components). Differences:

| element | Figma style (frame shows) | code role today | file:line | action |
|---|---|---|---|---|
| Option titles LANGUAGE/VARIANT/GRADER | 5768:23400: Label 14 uppercase · 5768:23886 (5768:24002): Title-small 17 | titleSmall | card-configurator.tsx:79 | ok vs newer |
| Option chips | 5768:23400: **mixed inside one frame** — Language chips 18px tall (Label 14), Variant/Grader chips 16px (Caption 13); 5768:23886: Label 14 | label | card-configurator.tsx:67 | ok vs newer; flag intra-frame drift |
| "PRICE TREND" title | 5768:23496: unstyled Medium 16 · 5768:23958 (Condition frame, 24 tall): Title-medium | titleMedium | card-price-trend-list.tsx:67 | ok vs newer |
| Condition row "NEAR MINT" | 5768:23500: **Caption Regular 13 UPPERCASE** · 5768:23962 (Condition frame, 19 tall): Body 15 sentence case | body + gradeLabel override 14/21 | card-price-trend-list.tsx:101, :216 | hardcoded → tokenize; Figma inconsistent (Caption vs Body) — code's 14 sits between; follow Body |
| Row price | Body-medium 15 | bodyMedium | card-price-trend-list.tsx:124 | ok |
| Row chevron (raw rows navigate) | icon only in Figma | iconoir NavArrowRight (no text) | card-price-trend-list.tsx | n/a |
| Pop Report block (also on Raw frame) | SemiBold 14 / Overline / Body-medium | — | — | missing-in-code |

## 3. Sheets ("Footer-modal-expanded")

### 3a. Condition picker (1664:2595, 5768:24117) + Grade picker (1640:6013)

| element | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| Sheet title "CONDITION" / "GRADE" | unstyled **SemiBold 13** gray900, centered | titleSmall (SemiBold 17) | cards/components/grade-condition-sheet.tsx:131 | change-role → Caption-medium-sized (Figma unstyled; raise with designer: title is 13 SemiBold, code is 17) |
| "CANCEL" text button (left) | unstyled SemiBold 13 gray600 | — (dismiss handle only) | grade-condition-sheet.tsx:126 | missing-in-code |
| Selected row "Near Mint" / "NEAR MINT" | **Label Medium 14** (both frames); grade sheet: unstyled SemiBold 14 | body (Regular 15), purple50 band, no weight change | grade-condition-sheet.tsx:160 | change-role (selected) → Label; unselected stays Body |
| Unselected rows | 1664:2595 + 1640:6013: Body Regular 15 gray700 · 5768:24117: Caption 13 UPPERCASE | body | grade-condition-sheet.tsx:160 | ok vs 1664/1640; 5768:24117 is drift |

### 3b. Add to collection (4211:84974 graded / 5938:7376 raw)

| element | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| Header "ADD TO COLLECTION" (center) | unstyled SemiBold 13 gray900 | bodyMedium gray600 | cards/components/add-to-collection-sheet.tsx:228 | change-role → Caption-medium (nearest to SemiBold 13; raise weight) |
| Header "CANCEL" (left) / "CONFIRM" (right, purple500) | unstyled SemiBold 13 | — (confirm is a footer Button, no cancel text) | add-to-collection-sheet.tsx:322-330 | missing-in-code (layout differs: footer dark Button vs header text) |
| Option titles LANGUAGE / VARIANT / GRADER / GRADE / QUANTITY / COST BASIS | Label 14 UPPERCASE | titleSmall (via CardConfigurator + local) | card-configurator.tsx:79; add-to-collection-sheet.tsx:255, :278 | ok vs newer PDP convention (Title-small); this sheet frame is on the old convention |
| Chips | Caption 13 | label | card-configurator.tsx:67 | ok vs newer (Label) |
| Grade selector "SELECT" | Caption Regular 13 | label (Medium 13) gray700 | add-to-collection-sheet.tsx:268 | change-role → Caption |
| Quantity "1" | Title-medium 19 | titleMedium | add-to-collection-sheet.tsx:300 | ok |
| Cost basis placeholder "$0.00 (OR VALUE IF GIFTED)" | Body Regular 15 gray400 | — in this sheet (lives on PDP owned-edit: bodyMedium) | owned-entry-edit-fields.tsx:159 | missing-in-code (sheet) / change-role → Body (PDP field) |
| Footer confirm button | Label 14 | Button labelStyleVariant="label" | add-to-collection-sheet.tsx:322 | ok |

### 3c. Confirm delete (5938:20747)

| element | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| Header "CONFIRM DELETE" / "CANCEL" | unstyled SemiBold 13 | bodyMedium title; cancel = outline Button | cards/components/confirm-delete-sheet.tsx:190, :211 | change-role → Caption-medium (raise weight) |
| Warning copy "YOU'RE ABOUT TO DELETE…" | Caption Regular 13 gray700, centered, UPPERCASE | body gray900 | confirm-delete-sheet.tsx:196 | change-role → Caption |
| "Delete" button | Label 14 (Primary, error fill) | Button variant="destructive" labelStyleVariant="label" | confirm-delete-sheet.tsx:201 | ok |

### 3d. Code-only sheets / menus (no Figma frame)

| element | code role today | file:line | action |
|---|---|---|---|
| Card actions sheet title / rows | bodyMedium / body | cards/components/card-actions-sheet.tsx:238, :256 | missing-in-figma (→ Body-medium / Body) |
| Inventory entry popover "Add another" / "Delete" | body | cards/components/inventory-entry-menu.tsx:116, :132 | missing-in-figma (→ Body) |

## 4. Sold-comps accordion (graded lane; `dev/price-trend-graded`)

No Figma frame shows the expanded accordion (checked 5768:21988, :22448, :22713, 5938:7158, 5753:10734 — all collapsed lists). Everything here is missing-in-figma; mapped by metrics:

| element | code role today | file:line | → Figma style |
|---|---|---|---|
| "Recent Sales" / "Lowest Listed" section headers | labelStrong (SemiBold 13) | card-detail-screen.tsx:1229, :1276 | Caption-medium (nearest; or Label if designer wants 14) |
| "Avg. last N sales · $x" / "Current listings" | overline (Medium 11) | card-detail-screen.tsx:1241, :1281 | Overline (Regular 12) |
| Sale / listing title | label gray700 | cards/components/card-recent-sales-panel.tsx:123; card-lowest-listed-panel.tsx:105 | Label |
| Sale date / listing type | label gray500 | card-recent-sales-panel.tsx:128; card-lowest-listed-panel.tsx:110 | Caption-medium (13 secondary) |
| Sale / listing price | bodyMedium | card-recent-sales-panel.tsx:133; card-lowest-listed-panel.tsx:115 | Body-medium |
| "No recent eBay sales found." | label gray500 | card-recent-sales-panel.tsx:178; card-lowest-listed-panel.tsx:159 | Caption |
| "See more on eBay ↗" / "Show N more sales" | labelStrong gray600 | card-recent-sales-panel.tsx:191, :248, :272; card-lowest-listed-panel.tsx:172, :228, :252 | Caption-medium |

## 5. Catalog (no Figma frames — mapped by metrics)

`catalog/**` has no frame in `figma-screen-inventory.md`. Recorded as missing-in-figma; nearest style by metrics:

| element | code role today | file:line | → Figma style |
|---|---|---|---|
| Search screen title "Search Cards" | ScreenHeader → display (+ micro eyebrow, body subtitle) | catalog/screens/catalog-search-screen.tsx:363; DS `components/screen-header.tsx:45-49` | Display (eyebrow → Overline, subtitle → Body) |
| "Browse Sets" / "<Game> Sets" / expansion name titles | display (raw `<Text>`) | catalog/screens/expansion-browser-screen.tsx:69; game-sets-screen.tsx:202; expansion-detail-screen.tsx:203 | Display |
| Search input text/placeholder | SearchField → body (lineHeight stripped) | DS `components/search-field.tsx:80-81` | Body |
| "Sealed products" / "Cards" section headers | SectionHeader → title (display 25) / titleSmall (compact); action "See all" → control | catalog/components/sealed-results-row.tsx:33, :65; DS `components/section-header.tsx:71, :133` | Title-medium; action → Label |
| Rarity / sealed filter chips | PillButton tone="filter" → label | catalog-search-screen.tsx (chip row) ; DS `components/pill-button.tsx:65-70` | Label |
| Expansion cell name / release date / image fallback | body / caption / caption | catalog/components/expansion-cell.tsx:55, :59, :49 | Body / Caption / Caption |
| Game mosaic tile name / set count / placeholder | body / caption / caption | catalog/components/game-mosaic-tile.tsx:96, :102, :86 | Body / Caption / Caption |
| Expansion-detail card name / number / fallback | caption / caption / caption | catalog/screens/expansion-detail-screen.tsx:78, :81, :67 | Caption (name arguably Caption-medium) |
| Result grid tiles | InventoryCardTile (DS) — hardcoded 14/21 + deltaPill 12 inside the primitive | catalog/components/catalog-results-grid.tsx:77; DS `components/inventory-card-tile.tsx:700-746` | Label / Body-medium (fix lives in the DS primitive, other area) |
| Loading / error / empty states | StateCard → headline + body | catalog-search-screen.tsx:234-322; game-sets-screen.tsx:82-134; expansion-detail-screen.tsx:169-180; DS `components/state-card.tsx:42-45` | Title-small / Body |

## 6. Hardcoded font literals in area files (outside tokens.ts)

| file:line | literal | context | action |
|---|---|---|---|
| cards/screens/card-detail-screen.tsx:3311-3313 | `fontFamily: fontFamilies.bodySemiBold, fontSize: 14, lineHeight: 21` | `styles.sinceAddedAmount` | tokenize (needs a SemiBold-14 role; none in Figma — closest Label with weight override, or add `labelStrong`→14) |
| cards/components/card-price-trend-list.tsx:216-217 | `fontSize: 14, lineHeight: 21` | `styles.gradeLabel` on top of `typography.body` | delete once Body = 14/18 |
| cards/components/owned-entry-edit-fields.tsx:146, :161 | `lineHeight: undefined` | strips line box for single-line TextInput ("$" + input) | keep (TextInput landmine, see comment :203) — not a literal size |
| cards/screens/scan-candidate-review-screen.tsx:299-301 | `fontSize: 15, letterSpacing: 0.6, lineHeight: 20, textTransform uppercase, color #6F7078` | `scanCandidateMeta` over `typography.caption` | tokenize → Caption; drop hex |
| cards/screens/scan-candidate-review-screen.tsx:306-307 | `fontSize: 15, lineHeight: 20, color #0F0F12` | `scanCandidateTitle` over `bodyStrong` | tokenize → Body-medium; drop hex |
| cards/screens/scan-candidate-review-screen.tsx:311-312 | `fontSize: 15, lineHeight: 20, color #0F0F12` | `scanCandidateValue` over `body` | tokenize → Body; drop hex |
| cards/screens/scan-candidate-review-screen.tsx:316-317 | `fontSize: 24, lineHeight: 24, color #6F7078` | `scanCandidateChevron` ("›" glyph) | replace with iconoir chevron (not text) |

No `fontWeight:` literals in the area. `catalog/**` has zero font literals. Design-system primitives this
area renders through that carry their own literals (other agent's area, listed so the flip isn't a surprise):
`components/card-list-row.tsx:436-438, :491-493, :500-501`, `components/inventory-card-tile.tsx:700-746`,
`components/trend-pill.tsx:95-102`, `components/screen-header.tsx:100` (letterSpacing 1.4),
`components/text-field.tsx:128`, `components/badge.tsx:79`.

## 7. Role → Figma style summary (this area) + inconsistencies

Most-used roles here (count = sites in cards/** + catalog/**): body 12, label 11, bodyMedium 10,
caption 9, titleSmall 8, labelStrong 8, titleMedium 5, bodyStrong 5, overline 3, headline 3, display 3,
captionMedium 2, titleLarge 1.

| role | → Figma | sites that must NOT follow the alias |
|---|---|---|
| body → Body | 12 | price-trend `gradeLabel` override dies; cost-basis input is bodyMedium → Body (weight) |
| label → Label (14) | 11 | inventory row summary → Caption-medium; grade "Select" → Caption |
| bodyMedium → Body-medium | 10 | inventory "INVENTORY" header → Caption-medium; add-to-collection + confirm-delete sheet titles → SemiBold 13 (unstyled in Figma) |
| caption → Caption (Regular 13) | 9 | all catalog meta; weight flips Medium→Regular — check contrast on gray textSecondary |
| titleSmall → Title-small | 8 | price-trend skeleton → Title-medium; grade/condition sheet title is 13 SemiBold in Figma |
| labelStrong → (none) | 8 | all 8 are sold-comps accordion; propose Caption-medium or ask for a "Label-strong" style |
| titleMedium → Title-medium | 5 | ok |
| bodyStrong → (none) | 5 | product-details inline label (Bold 15 unstyled); scan-candidate title |
| display → Display | 3 catalog + ScreenHeader | ExtraBold 36 → Bold 29, big visual drop; catalog has no frames to verify against |

Figma inconsistencies to raise with the designer:

1. **Two conventions on the same page.** Old-library frames (5768:21988, 5768:23400, 4211:84974, 5938:7376, 5938:25164/25794, 5938:7158) use Label-14-UPPERCASE option titles, Caption-13 chips, unstyled Medium-16-UPPERCASE "PRICE TREND"/"PRODUCT DETAILS". Newer frames (5768:22713, 5768:23886, 5753:10734) use Title-small sentence-case titles, Label-14 chips, Title-medium section titles. Code already matches the NEWER set; the older frames need "update from library" + a text-style pass.
2. **Body / Body-medium = 15 on every PDP frame** (library drift; canonical 14). Every "Price", "Card Number", condition row and product-detail value will shrink by 1pt when the token re-cut lands — that is intended, but the frames will disagree with the simulator until updated.
3. **Raw frame 5768:23400 is internally inconsistent**: Language chips are Label 14, Variant/Grader chips are Caption 13 in the same Product Options block.
4. **Condition rows disagree across frames**: Caption 13 UPPERCASE (5768:23400, 5768:24117) vs Body 15 sentence-case (5768:23886 rows, 1664:2595). Grade rows are Body 15 everywhere.
5. **Sheet headers are unstyled SemiBold 13** (CANCEL / CONDITION / ADD TO COLLECTION / CONFIRM DELETE / GRADE) on every Footer-modal frame — no library style covers SemiBold 13. Code uses titleSmall 17 (grade sheet) and bodyMedium 14 (other sheets). Needs either a new "Label-strong"/"Caption-strong" style or a decision to use Caption-medium.
6. **Pop Report** (POP REPORT title SemiBold 14, cell titles Overline, values Body-medium) is on every PDP frame (graded AND raw) and has no code at all.
7. **Product-details inline labels** ("Card Number / Rarity:") are Bold 15 spans with no style; code's bodyStrong is SemiBold 15. Ask whether a Body-bold style is intended.
8. **Sold-comps accordion, similar-cards rail, since-added row, owned-edit "Updated" stamp, loading/error states** exist in code but on no Figma frame.
9. **Add-to-collection sheet layout** differs: Figma has CANCEL / CONFIRM as header text buttons and a COST BASIS field; code has a footer dark Button and no cost basis in the sheet (cost basis lives in the PDP owned-edit fields).
10. Title-medium 19 for the sticky header card name vs Title-large 23 for the identity name is consistent across all frames and matches code.
