# Type-scale mapping — Profile / Collection / Activity / Insights / Wishlist / Transactions

Phase-1 inventory, 2026-10-18. Read-only. Figma file `XRUD89H31ESUrvf9fGMtjW`. Frames pulled with
`get_design_context`; text extracted per `<p>` (font style + px). Code lines are as of today's working tree.

Legend — **action**: `ok` = same metrics once the legacy role is re-cut/aliased to the named Figma style ·
`change-role → X` = call site must move to a different role · `hardcoded → tokenize` = raw
`fontFamily/fontSize/lineHeight` literal · `missing-in-figma` = code text the frame doesn't have ·
`missing-in-code` = frame text the app doesn't render · `unstyled` = Figma text not on any library style
(nearest style given in parentheses).

Code metrics today (tokens.ts): `label` Med 13/18.2 · `labelStrong` SB 13 · `labelLight` Light 13 ·
`bodyMedium` Med 14/21 · `bodySmall` Reg 14/21 · `body` Reg 15/20 · `bodyStrong` SB 15 · `headline` SB 16 ·
`titleXsmall` SB 14 · `titleSmall` SB 17 · `titleMedium` SB 18 · `display` ExtraBold(display) 36 ·
`caption` Med 12/16 · `captionMedium` Med 12/16.8 · `overline` Med 11 · `navLabel` Med 11 · `micro` SB 11 ls0.8 ·
`priceCaption` Bold 12 · `control` SB 15.

Paths: `RN = apps/spotlight-rn/src`, `DS = packages/design-system/src/components`.

---

## 1. Collection / Portfolio home (`spotlight://dev/portfolio`)

Frames: You-section 4134:50566 (= 5938:19860/20233 grid variants are identical list layouts), View-others
5938:32705, Move 5938:24326, Edit-profile parent 5938:33178 — all share the same header/list. The
"Components" reference frame 3725:59667 is **stale** (Title-case chips on Label, Body-medium = 14; see §10).
Code follows the You-section frames.

| element | Figma style (metrics) | code role today | file:line | action |
|---|---|---|---|---|
| Follower stats `2 FOLLOWERS` | Label (Med 14) | `bodyMedium` + lineHeight 17.6 | RN/features/profile/components/profile-header.tsx:369, :431-435 | ok (bodyMedium→Label); drop the 17.6 override once Label lh=18 |
| Bio / bio placeholder | unstyled Light 13 (→Caption) | `labelLight` | profile-header.tsx:282, :289 | unstyled in Figma; keep `labelLight` or move to Caption — designer call |
| Display name | Title-medium (SB 19) | `titleMedium` | profile-header.tsx:210 | ok |
| Handle `JOHN` | unstyled Reg 14 (→Body) | `bodySmall` + lineHeight 17.6 | profile-header.tsx:227, :431 | ok (bodySmall→Body 14); drop override |
| Social link `wabi.ly/…` | Label (Med 14) | `bodyMedium` + lineHeight 17.6 | profile-header.tsx:244 | ok (bodyMedium→Label); drop override |
| Social link (non-openable) | Label | `label` (Med 13) | profile-header.tsx:253 | change-role → Label |
| FOLLOW / MESSAGE buttons (View others) | Label (Med 14) | Button `labelStyleVariant="label"` → `label` Med 13 | RN/features/profile/screens/public-profile-screen.tsx:822-836 | change-role → Label |
| Balance label `MAIN COLLECTION` | unstyled Light 12 (→Overline) | raw bodyMedium 12/16.8 | RN/features/portfolio/components/portfolio-balance-header.tsx:215-217 | hardcoded → tokenize (Overline) |
| Balance value `$17,400.47` | Display (Bold 29) | raw bodyBold 28/33.6 | portfolio-balance-header.tsx:226-228 | hardcoded → tokenize (Display) |
| Delta `$3.99 (3.20%)` | unstyled SB 14 lh 1.5 (→Label) | raw bodySemiBold 14/21 | portfolio-balance-header.tsx:248-250 | hardcoded → tokenize; no SB-14 style exists — flag |
| Scrub date (not in Figma) | — | raw bodyMedium 12/16.8 | portfolio-balance-header.tsx:255-257 | hardcoded → tokenize; missing-in-figma |
| Range pills `7D 1M 3M 1Y ALL` | Label (Med 14) | raw bodyMedium 13/16.4, selected SB /18.2 | RN/features/portfolio/components/portfolio-chart-card.tsx:1180-1187 | hardcoded → tokenize (Label); selected weight SB has no Figma style |
| Chart tooltip date / value | missing-in-figma | raw SB 10/13, Reg 12/15.6 | portfolio-chart-card.tsx:1154-1161 | hardcoded → tokenize (Overline-ish); missing-in-figma |
| Tabs COLLECTION / FOR SALE / ACTIVITY | Caption-medium (Med 13) sel, Caption (Reg 13) unsel | `bodyMedium` + fontSize 15 / lh 18 (Figma 14 +1 by user 2026-09-04) | DS/page-tabs.tsx:67-78, :212-216 | hardcoded → tokenize; user overrode size — keep 15 or re-decide; Figma now 13 |
| Summary `MAIN COLLECTION` / `TOTAL: $10.3k` | Caption (Reg 13) | `bodyMedium` (Med 14) | RN/features/portfolio/components/collection-search-row.tsx:166-167; public-profile-screen.tsx:923-924 | change-role → Caption |
| Search placeholder `SEARCH BY VENDOR OR HOBBY` | unstyled Light 13 (→Caption) | `label` (Med 13, lineHeight stripped) via `size="collection"` | DS/search-field.tsx:80-81; collection-search-row.tsx:105 | change-role → Caption (or Light if designer styles it); copy is stale in Figma |
| Filter chips ALL / LIKES / A-Z / PRICE / DATE / UNGRADED / GRADED | Caption (Reg 13) | PillButton filter → `label` (Med 13) | DS/pill-button.tsx:65; RN/features/portfolio/components/collection-filter-chip-row.tsx:117 | change-role → Caption |
| Card name | Title-small (SB 17) | `titleSmall` | DS/card-list-row.tsx:325 | ok |
| Card meta `193/162 · Perfect Order` / footnote | Caption (Reg 13) | `label` (Med 13) | card-list-row.tsx:329, :343 | change-role → Caption |
| Grade `PSA 10` / `NEAR MINT` / `Qty:` | Caption (Reg 13) | `label` | card-list-row.tsx:352, :361 | change-role → Caption |
| Card price `$1,450.12` | unstyled Bold 15 (nearest Body-medium) | `bodyStrong` + raw `SpotlightBodyBold` 14/21 | card-list-row.tsx:372-377, :436-438 | hardcoded → tokenize; no Bold-15 style — flag (user overruled Regular 2026-08-18) |
| Trend line / suffix | missing-in-figma | raw `SpotlightBodySemiBold` 14/21; suffix = label family/size | card-list-row.tsx:491-493, :500-501 | hardcoded → tokenize |
| Thumb placeholder `CARD` | missing-in-figma | `micro` | card-list-row.tsx:278, :310 | missing-in-figma |
| Grid tile name (grid view) | no current grid frame in "You" (old 1874:21732 only) | `headline` (SB 16) | DS/inventory-card-tile.tsx:404 | change-role → Title-small (match list) |
| Grid tile set / grade / qty / footnote | — | `label` | inventory-card-tile.tsx:414-434, :486, :538 | change-role → Caption (match list) |
| Grid tile price | — | `priceCaption` + fontSize 14 / lh 21 | inventory-card-tile.tsx:447, :700-701 | hardcoded → tokenize |
| Grid tile day-change pill / trend / eBay label | — | `deltaPill`+fontSize 12; raw SB 14/21; `cardMeta` | inventory-card-tile.tsx:727-728, :744-746, :568 | hardcoded → tokenize |
| Cross-collection section header | missing-in-figma | SectionHeader → `titleSmall`/`title` | DS/section-header.tsx:71; portfolio-screen.tsx:1520 | ok (titleSmall); `title` uses display family — retire |
| Stale hint `Your backend data is loading…` | missing-in-figma | `captionMedium` | RN/features/portfolio/screens/portfolio-screen.tsx:1750 | ok → Caption-medium |
| Activity empty `Create a post…` | missing-in-figma | `body` | portfolio-screen.tsx:1803 | ok → Body |
| Select-mode bar count / error | missing-in-figma | `overline` | portfolio-screen.tsx:2214, :2221 | ok → Overline |
| Select-mode actions Done / Select All / Delete | missing-in-figma | `navLabel` (Med 11) | portfolio-screen.tsx:2236-2259 | change-role → Caption (navLabel is tab-bar only) |
| StateCard title / body (errors, "Coming soon") | missing-in-figma | `headline` / `body` | DS/state-card.tsx:42-45 | headline → Title-small |
| EmptyStatePrompt message | missing-in-figma | `bodyMedium` | DS/empty-state-prompt.tsx:55 | ok → Label |
| Tab bar HOME/WISHLIST/SCAN/EVENTS/SOCIAL | unstyled SB 9 lh 12 (ref frame: SB 10) | `navLabel`/`navLabelSelected` Med/SB 11 | DS/bottom-tab-bar.tsx:167 | Figma unstyled & inconsistent (9 vs 10) — designer to pick; out of scope for the 11 styles |

Not in code: the "glass" toolbar (menu / search / pencil / share) has no text. `Verified` badge text (SB 12,
ref frame only) is an icon in the app.

## 2. Side menu / drawer (`RN/components/app-drawer.tsx`)

Figma: the open drawer appears only inside the stale reference frame 3725:59667 (nodes 3725:60048-60121).

| element | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| Avatar initials | — (image in Figma) | `...textStyles.bodyMedium` + fontSize 16 | app-drawer.tsx:533-535 | hardcoded → tokenize (Body-large) |
| Name `Dunk E.` | unstyled SB 15 lh 1.5 (→Body-medium) | `...textStyles.titleMedium` (SB 18) | app-drawer.tsx:542 | change-role → Body-medium / designer to style |
| `MEMBER SINCE 2026` | Overline (Reg 12) | raw bodyRegular 12/16.8 | app-drawer.tsx:547-549 | hardcoded → tokenize (Overline) |
| Stat labels `PORTFOLIO VALUE` / `TOTAL ITEMS` | Overline (Reg 12) | `...textStyles.overline` (Med 11) | app-drawer.tsx:565 | ok (overline→Overline) |
| Stat values `$17,400.47` / `842` | unstyled SB 15 lh 1.5 | `...textStyles.titleMedium` (SB 18) | app-drawer.tsx:569 | change-role → Body-medium (or Title-small) |
| Nav items PROFILE / WISHLIST / INSIGHTS / SCAN / EVENTS / LOG OUT | Caption-medium (Med 13) | `...textStyles.bodyMedium` (Med 14) | app-drawer.tsx:589 | change-role → Caption-medium |
| Nav badge count | missing-in-figma | `...textStyles.overline` | app-drawer.tsx:605 | ok |

## 3. Public profile / "View others" (5938:32705)

Same header + list as §1 (rows identical). Deltas only:

| element | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| FOLLOW / MESSAGE | Label (Med 14) | Button `label` (Med 13) | public-profile-screen.tsx:822-836 | change-role → Label |
| `Main Collection` / `Total Value:` row | Caption (Reg 13), uppercase in Figma | `bodyMedium` | public-profile-screen.tsx:923-924 | change-role → Caption (+ copy case) |
| Follow button (DS) | Label | `bodyMedium` + lh 18 | DS/follow-button.tsx:54, :104 | ok → Label (lh 18 matches policy) |

## 4. Followers / Following (5753:12867)

| element | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| Toolbar title `WabiSabi` | Title-medium (SB 19) | `titleMedium` | RN/features/profile/screens/follow-list-screen.tsx:184 | ok |
| Tabs `120 FOLLOWERS` / `FOR SALE` | Caption (Reg 13) sel+unsel (selected only differs by color) | not built (deferred) | — | missing-in-code |
| Row name | Body-medium (**Med 15** here) | `bodyMedium` (Med 14) | follow-list-screen.tsx:115; people-search-screen.tsx:178 | ok if Body-medium re-cut to 14; Figma drift (15) — see §10 |
| Row handle `John` | unstyled Reg 12 uppercase (→Overline) | `label` (Med 13) | follow-list-screen.tsx:130; people-search-screen.tsx:188 | change-role → Overline |
| Find People title / `Popular collectors` | no frame | `titleXsmall` | people-search-screen.tsx:208, :237 | missing-in-figma (→ Title-small) |

## 5. Activity tab (5938:31069) and comments sheet (5938:32117)

Post cells render `features/social/components/post-card.tsx` (social area — not mapped here). Profile-area text only:

| element | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| Tabs COLLECTION / FOR SALE / ACTIVITY | Caption-medium sel / Caption unsel | PageTabs `bodyMedium` 15/18 | DS/page-tabs.tsx:67-78 | see §1 |
| Compose prompt `WHATS ON YOUR MIND?` | Caption (Reg 13) | social area | — | — |
| FOLLOW button in post header | Caption (Reg 13) | social area | — | — |
| Post author | unstyled SB 16 (one cell SB 15) | social area | — | Figma inconsistent (16 vs 15) |
| Post date | Overline (Reg 12) | social area | — | — |
| Post body | Body-medium (Med 15) | social area | — | — |
| Reaction counts | unstyled SB 13 | social area | — | — |
| Comments sheet title `COMMENTS` | unstyled SB 13 | social area | — | — |
| Comment author/time | Body-medium (Med 15) · body Body (Reg 15) · `3 replies` Label | social area | — | — |

## 6. Edit profile (5938:33178 page, 5938:34181 sheet)

Figma is a bottom sheet; app is a full-page push (structural divergence already recorded in design-map).

| element | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| Title `EDIT PROFILE` | unstyled SB 14 (→Label) | `titleXsmall` (SB 14) | RN/features/profile/screens/edit-profile-screen.tsx:528 | unstyled in Figma; metrics match today — ask designer to style (Label vs new SB-14) |
| Field placeholders `Enter Profile Name` / `Enter Social Link` / `Enter Location` | Body (Reg 15; sheet) | raw `SpotlightBodyRegular` 14 | edit-profile-screen.tsx:801-804 | hardcoded → tokenize (Body 14 per re-cut) |
| Floating field label (when filled) | missing-in-figma (sheet shows placeholders only) | `overline` | edit-profile-screen.tsx:122 | ok → Overline |
| Social link value | — | raw `SpotlightBodyMedium` 13 | edit-profile-screen.tsx:816-817 | hardcoded → tokenize (Caption-medium) |
| `Bio` label | unstyled Med 12 (→Overline/Caption-medium) | `caption` (Med 12) | edit-profile-screen.tsx:607 | caption → Caption-medium or Overline; metrics match today |
| `0/150` counter | Caption (Reg 13) | `caption` (Med 12) | edit-profile-screen.tsx:610 | change-role → Caption |
| Bio input `Tell us about you...` | Body (Reg 15) | raw `SpotlightBodyRegular` 14/18 | edit-profile-screen.tsx:769-771 | hardcoded → tokenize (Body) |
| `Verify page` | Label (Med 14) | `label` (Med 13) | edit-profile-screen.tsx:651 | change-role → Label |
| CANCEL / SAVE | Label (Med 14) | Button `label` (Med 13) | edit-profile-screen.tsx:692-713 | change-role → Label |

## 7. New Collection sheet (5753:4753) and Move sheet (5938:24326)

| element | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| Sheet title `Collection` | unstyled Med 16 (→Body-large/Title-small) | `...textStyles.titleXsmall` (SB 14) | RN/features/portfolio/components/collection-picker-sheet.tsx:752-753 | change-role; Figma unstyled — designer to pick |
| CANCEL / ADD actions | unstyled SB 13 (→Caption-medium) | `...textStyles.labelStrong` (SB 13) | collection-picker-sheet.tsx:642-643 | metrics match; no SB-13 style in Figma — flag |
| Row title (collection name) | Body-medium (Med 15 on this frame) | `...textStyles.bodyMedium` | collection-picker-sheet.tsx:738-739 | ok (→Label/Body-medium 14) |
| Row value (count / total) | Label / Caption | `...textStyles.label` | collection-picker-sheet.tsx:742-743 | change-role → Caption |
| `Enter Portfolio Name` input | Body (Reg 15) | TextField → `body` minus lh | DS/text-field.tsx:58-59 | ok → Body |
| TextField floating label / helper | — | `micro` (ls 1.2) / `caption` | DS/text-field.tsx:64, :101, :128 | micro → Overline; caption → Caption |
| Error text | missing-in-figma | `...textStyles.label` | collection-picker-sheet.tsx:653-654 | ok → Caption |
| Move helper `CHOOSE WHERE TO MOVE YOUR SELECTED ITEMS.` | Caption (Reg 13) | none (no helper copy in the picker sheet) | collection-picker-sheet.tsx | missing-in-code |
| Header stats `2 Followers / Following / Fame` (this frame only) | Title-small count + Body label | StatText `bodyMedium` | profile-header.tsx:369 | stale frame variant; You-section uses `2 FOLLOWERS` Label — ignore |

## 8. Insights (`spotlight://dev/insights`, 5689:18271; Filter sheet 2664:25051)

| element | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| Toolbar title `INSIGHTS` | unstyled SB 14 | none — toolbar is icon-only GlassNavBubbles | RN/features/insights/screens/insights-screen.tsx:~290-303 | missing-in-code |
| Category `POKEMON` | Title-small (SB 17) | `titleMedium` (SB 18) | insights-screen.tsx:310 | change-role → Title-small |
| `57 ITEMS` | Caption (Reg 13) | `label` (Med 13) | insights-screen.tsx:315 | change-role → Caption |
| Search `SEARCH YOUR COLLECTION` | unstyled Light 13 | SearchField `label` | insights-screen.tsx:332; DS/search-field.tsx:80 | change-role → Caption |
| Filter chips | Caption (Reg 13) | PillButton `label` | RN/features/insights/components/insights-filter-chip-row.tsx:69 | change-role → Caption |
| `PORTFOLIO` tag | Caption (Reg 13) | `captionMedium` (Med 12) | RN/features/insights/components/performance-table.tsx:90 | change-role → Caption |
| Column headers GRAPH / CURRENT / $ 1M G/L … | unstyled Med 12 lh 1.4 (→Overline) | `captionMedium` (Med 12) | performance-table.tsx:118 | metrics match; Figma unstyled — flag |
| Row card name | unstyled Bold 14 (→Label) | `label` (Med 13) | performance-table.tsx:262 | change-role → Label; Bold weight has no style |
| Row `100/101` | Caption (Reg 13) | `label` | performance-table.tsx:268 | change-role → Caption |
| Row `NEAR MINT` | Overline (Reg 12) | `label` | performance-table.tsx:278-287 | change-role → Overline |
| Metric cells `$600 / 5% / 400%` | Body (Reg 15) | `bodySmall` (Reg 14) | performance-table.tsx:302-323 | ok (bodySmall→Body 14) |
| Empty text | missing-in-figma | `body` | insights-screen.tsx:407 | ok |
| Sheet CANCEL / APPLY | unstyled SB 13 | `labelStrong` (SB 13) | RN/features/insights/components/insights-sort-sheet.tsx:182, :199 | metrics match; flag unstyled |
| Sheet title `FILTER BY` | unstyled SB 13 | `titleSmall` (SB 17) | insights-sort-sheet.tsx:187 | change-role (Figma shows 13 — likely a Figma error; Title-small intended?) |
| Sheet options | Caption (Reg 13); selected Med 13 (Caption-medium) | `bodySmall` / `titleXsmall` | insights-sort-sheet.tsx:223 | change-role → Caption / Caption-medium |

## 9. Wishlist (`spotlight://dev/wishlist`, 5656:9898)

| element | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| Header title `WISHLIST` | unstyled SB 14 | AppText `titleMedium` ("Watchlist") | RN/features/wishlist/components/wishlist-header.tsx:260-265 | change-role; Figma unstyled; copy differs (Wishlist vs Watchlist) |
| Search placeholder | unstyled Light 13 | SearchField `label` | RN/features/wishlist/screens/wishlist-screen.tsx:847 | change-role → Caption |
| Filter chips | Caption (Reg 13) | PillButton `label` | wishlist-screen.tsx:858 | change-role → Caption |
| Row name / meta / grade / price | Title-small / Caption (3-span Reg 13) / Caption / unstyled Bold 15 | CardListRow (see §1) | DS/card-list-row.tsx | as §1 |
| Loading / empty text | missing-in-figma | raw `SpotlightBodyRegular` 14/20 | wishlist-screen.tsx:1484-1486, :924, :941 | hardcoded → tokenize (Body) |
| Empty state (WatchlistEmptyState) | missing-in-figma | `titleSmall`/`label`/`titleMedium`/`bodyMedium` | RN/features/wishlist/components/watchlist-empty-state.tsx:63-75 | ok after alias |
| Edit bar count / error | missing-in-figma | `overline` | wishlist-screen.tsx:1038, :1045 | ok |
| Edit bar Select All / Delete | missing-in-figma | `navLabel` | wishlist-screen.tsx:1059, :1072 | change-role → Caption |
| Swipe `Delete` / deal `Dismiss` | missing-in-figma | `caption` (Med 12) | wishlist-screen.tsx:1249; deal-radar-band.tsx:202 | → Caption-medium |
| Deal band name / printing / prices | missing-in-figma | `titleSmall` / `label` / `labelStrong` | RN/features/wishlist/components/deal-radar-band.tsx:245-276 | label → Caption |
| Target-price sheet title / explainer / name / market / message | missing-in-figma | `bodyMedium` / `body` / `titleSmall` / `label` / `caption` | RN/features/wishlist/components/target-price-sheet.tsx:218-270 | aliases ok; label → Caption |

## 10. Transactions (1874:22334) vs Sales history (`features/portfolio/screens/sales-history-screen.tsx`)

design-map already records: 1874:22334 is the **future marketplace ledger**, not the per-card sales
screen. Mapped for the token audit anyway; the screen will be rebuilt against this frame.

| element | Figma style | code role today | file:line | action |
|---|---|---|---|---|
| Title `TRANSACTIONS` | unstyled SB 14 | `headline` (SB 16) | sales-history-screen.tsx:285 | change-role (→ Label / SB-14 if added) |
| Page heading `All Transactions` / `N shown` | missing-in-figma | `display` (ExtraBold 36) / `headline` | sales-history-screen.tsx:290-291 | display → Display (Bold 29) or drop heading |
| Search placeholder | unstyled Light 13 | SearchField `body` (non-collection size) | sales-history-screen.tsx:295 | change-role → Caption |
| Filter chips ALL / LIKES / DATE / PRICE / SOLD / PURCHASED / TRADED | Caption (Reg 13) | PillButton `label` | sales-history-screen.tsx:355-367 | change-role → Caption |
| Section label (`SORT` etc.) | — | `micro` + letterSpacing 1.8 | sales-history-screen.tsx:78, :533 | hardcoded ls → tokenize; micro → Overline |
| Day header `SUNDAY, MAY 25` | Body-medium (Med 15) | not built | — | missing-in-code |
| Row kind `BUY / TRADE / SELL` | Label (Med 14) | sale name `headline` (SB 16) | sales-history-screen.tsx:134 | change-role → Label |
| Row `27 ITEMS · CASH` | Caption (Reg 13) | `label` | sales-history-screen.tsx:142-146 | change-role → Caption |
| Amount `$1,450.12` (red/green) | unstyled Med 16 (→Body-large) | `headline` (SB 16) | sales-history-screen.tsx:138 | change-role → Body-large; Figma unstyled |
| Today card label / stats | missing-in-figma | `caption` / `display` | sales-history-screen.tsx:313-344 | display → Display |
| Edit-sale sheet close `×` / price input | missing-in-figma | `headline` + lh 20 / `display` + lh 40 | RN/features/portfolio/components/sale-price-edit-sheet.tsx:105, :124, :151, :169 | hardcoded lh → tokenize |
| Inventory browser (`features/inventory`) headings | no frame | `display` / `headline` / `micro` + ls 1.8 / `body` | RN/features/inventory/screens/inventory-browser-screen.tsx:104, :233-241, :372, :394-402, :464, :499 | display → Display; ls literals → tokenize |

---

## 11. Hardcoded font literals in the area (outside tokens.ts)

| file:line | literal | element |
|---|---|---|
| RN/features/portfolio/components/portfolio-balance-header.tsx:215-217 | bodyMedium 12 / lh 16.8 | balance label |
| …portfolio-balance-header.tsx:226-228 | bodyBold 28 / lh 33.6 | balance value |
| …portfolio-balance-header.tsx:248-250 | bodySemiBold 14 / lh 21 | delta |
| …portfolio-balance-header.tsx:255-257 | bodyMedium 12 / lh 16.8 | scrub date |
| RN/features/portfolio/components/portfolio-chart-card.tsx:1154-1156 | bodySemiBold 10 / lh 13 | tooltip date |
| …portfolio-chart-card.tsx:1159-1161 | bodyRegular 12 / lh 15.6 | tooltip value |
| …portfolio-chart-card.tsx:1180-1182 | bodyMedium 13 / lh 16.4 | range pill |
| …portfolio-chart-card.tsx:1186-1187 | bodySemiBold / lh 18.2 | range pill selected |
| RN/features/portfolio/components/sale-price-edit-sheet.tsx:151 | lineHeight 20 | close glyph |
| …sale-price-edit-sheet.tsx:169 | lineHeight 40 | price input |
| RN/features/portfolio/screens/sales-history-screen.tsx:533 | letterSpacing 1.8 | section label |
| RN/features/profile/components/profile-header.tsx:431, :434 | lineHeight 17.6 | handle / link / stats |
| RN/features/profile/screens/edit-profile-screen.tsx:769-771 | 'SpotlightBodyRegular' 14 / lh 18 | bio input |
| …edit-profile-screen.tsx:801-804 | 'SpotlightBodyRegular' 14 | field input |
| …edit-profile-screen.tsx:816-817 | 'SpotlightBodyMedium' 13 | social-link value |
| RN/features/wishlist/screens/wishlist-screen.tsx:1484-1486 | 'SpotlightBodyRegular' 14 / lh 20 | empty/loading text |
| RN/features/inventory/screens/inventory-browser-screen.tsx:464, :499 | letterSpacing 1.8 | section/filter labels |
| RN/components/app-drawer.tsx:535 | fontSize 16 (over bodyMedium spread) | avatar initials |
| RN/components/app-drawer.tsx:547-549 | bodyRegular 12 / lh 16.8 | member-since |
| DS/card-list-row.tsx:436-438 | 'SpotlightBodyBold' 14 / lh 21 | row price |
| DS/card-list-row.tsx:491-493 | 'SpotlightBodySemiBold' 14 / lh 21 | row trend |
| DS/card-list-row.tsx:500-501 | label family/size | trend suffix |
| DS/inventory-card-tile.tsx:700-701 | fontSize 14 / lh 21 | tile price |
| DS/inventory-card-tile.tsx:727-728 | deltaPill + fontSize 12 | day-change pill |
| DS/inventory-card-tile.tsx:731-732 | label family/size | trend suffix |
| DS/inventory-card-tile.tsx:744-746 | bodySemiBold 14 / lh 21 | tile trend |
| DS/page-tabs.tsx:212-222 | fontSize 15 / lh 18 (+ family swap :75-77) | profile tabs |
| DS/follow-button.tsx:104 | lineHeight 18 | FOLLOW label |
| DS/text-field.tsx:128 | letterSpacing 1.2 | floating label |
| DS/screen-header.tsx:100 | letterSpacing 1.4 | eyebrow |
| DS/trend-pill.tsx:95-102 | 'SpotlightBodySemiBold' 11/14, 13/16 | trend pill |

The `'SpotlightBody*'` string literals equal `fontFamilies.*` — they bypass the token only by spelling.

---

## 12. Role → Figma style summary (roles this area leans on)

| code role (usage count, repo-wide) | metrics today | Figma style to alias to | notes |
|---|---|---|---|
| `label` (51) | Med 13/18.2 | **Caption** (Reg 13) for meta/chips/placeholders; **Label** (Med 14) for links/buttons | Split: most `label` sites in this area are Figma *Caption*; the Med-14 ones (social link, Verify page, buttons) are *Label*. Cannot alias one-to-one — needs the per-site changes above. |
| `bodyMedium` (37) | Med 14/21 | **Label** (Med 14) / Body-medium (Med 14 on Home) | Figma's Body-medium drifts 14↔15; both resolve to 14 per README. |
| `bodySmall` (17) | Reg 14/21 | **Body** (Reg 14) | ok |
| `body` (66) | Reg 15/20 | **Body** (Reg 14) | size drops 1pt |
| `caption` (43) | Med 12/16 | **Caption-medium** (Med 13) or **Overline** (Reg 12) | this area: counter → Caption, Bio label → Overline, swipe actions → Caption-medium |
| `captionMedium` (26) | Med 12/16.8 | **Caption-medium** (Med 13) | Insights headers are Med 12 unstyled in Figma |
| `overline` (9) | Med 11/14.3 | **Overline** (Reg 12) | ok |
| `titleSmall` (18) | SB 17 | **Title-small** | ok |
| `titleMedium` (8) | SB 18 | **Title-medium** (SB 19) | ok; drawer/Wishlist/Insights uses need per-site changes |
| `headline` (24) | SB 16 | **Title-small** (SB 17) | tile name, StateCard title, sales rows |
| `titleXsmall` (13) | SB 14 | no Figma style (toolbar titles are unstyled SB 14) | ask designer: style toolbar titles (Label? new "Title-xsmall"?) |
| `labelStrong` (14) | SB 13 | no Figma style (sheet actions unstyled SB 13) | same ask |
| `labelLight` (2) | Light 13 | no Figma style (bio/search placeholders unstyled Light 13) | same ask |
| `bodyStrong` (15) | SB 15 | no Figma style (prices unstyled Bold 15) | needs a price style |
| `display` (13) | ExtraBold 36 display | **Display** (Bold 29) | sales-history / inventory / sale-price sheet |
| `navLabel` (6) | Med 11 | none (tab bar SB 9/10 unstyled) | misused for select-bar actions → Caption |
| `micro` (14) | SB 11 ls 0.8 | **Overline** | section labels; drop letterSpacing literals |

## 13. Figma inconsistencies noticed

1. **Reference frame 3725:59667 ("Components") is stale** vs the "You"/View-others/Move/Edit-profile frames:
   Title-case chips + search + card meta on *Label* (Med 14) vs uppercase on *Caption* (Reg 13); tabs
   Med/Reg 14 vs 13; `Portfolio` Med 13 vs `MAIN COLLECTION` Light 12; tab bar SB 10 vs SB 9; Body-medium
   14 vs 15 elsewhere. Code should follow the You-section frames (README decision).
2. **Body-medium drift**: Med 14 on Collection-Portfolio ref frame; Med 15 on Activity, Followers,
   Transactions, New Collection, comments sheet.
3. **Card price `$1,450.12` is unstyled Bold 15 on every list frame** (10 per frame, the largest unstyled
   group in the area). No Bold 15 style exists — request one (or confirm Body-medium + bold).
4. **Unstyled text with no matching library style** (recurring): toolbar titles SB 14 (`INSIGHTS`,
   `WISHLIST`, `TRANSACTIONS`, `EDIT PROFILE`); sheet actions SB 13 (`CANCEL`/`APPLY`/`ADD`/`COMMENTS`,
   Insights `FILTER BY`); Light 13 bio + search placeholders; Light 12 `MAIN COLLECTION`; balance delta SB 14
   lh 1.5; tab bar SB 9; Insights column headers Med 12 and card names Bold 14; Transactions amount Med 16;
   New Collection sheet title Med 16; drawer name/stat values SB 15 lh 1.5.
5. **Overline exists but isn't applied**: Followers handle `John` (Reg 12 uppercase) and Insights `NEAR MINT`
   (Reg 12 — applied there) are the same metrics; Followers rows are raw.
6. **Wishlist meta line** `100/101 · Dragon Frontiers` is three Reg-13 spans in a 0px parent — metrically
   Caption but not on the style; the Collection frames render the same line as one Caption node.
7. **Activity posts**: author name SB 16 in two cells, SB 15 in the third; post body on Body-medium (Med 15).
8. **Edit-profile Bio row**: `Bio` Med 12 (unstyled) next to `0/150` on Caption (Reg 13) — intentional?
9. **Insights sheet title `FILTER BY` is SB 13** while every other sheet title in the file is larger — likely
   a Figma slip; app uses Title-small.
10. Search placeholder copy `SEARCH BY VENDOR OR HOBBY` is pasted onto Collection, Wishlist, Transactions,
    and Edit-profile frames (copy, not type — but it means the placeholder style was never revisited).
11. Transactions (1874:22334) is the marketplace ledger, not sales-history (already in design-map); the
    current sales-history screen has no frame.
