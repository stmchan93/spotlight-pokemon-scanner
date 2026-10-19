# Type-scale + casing audit — final closure, 2026-10-19

Supersedes [audit-2026-10-18.md](audit-2026-10-18.md) on **casing**; that audit's size/weight verdicts still stand
(nothing in this pass changed a role). Inputs: `.design-sync/typescale/final/*.png` (all 28 dev routes,
iPhone 16 Pro Max, cold-relaunched dev client after every `textTransform` edit), `final/states/*.png` for the
secondary states reached with Maestro (Portfolio → Activity tab, drawer open, PDP scrolled to the price ladder),
and a fresh render of the newest Figma frame per screen (file `XRUD89H31ESUrvf9fGMtjW`, `get_screenshot`).
Contact sheet: `.design-sync/typescale/final/contact.jpg`.

Verdicts: **match** = every label / chip / tab / header / date / button reads with the frame's casing, weight,
size and colour, nothing truncates or clips · **match (copy)** = casing/metrics match but a string differs
(product copy, not typography) · **no frame** = mapped by the nearest frame's conventions · **left** = a real
difference deliberately not changed, with the reason.

**Counts: 28 routes captured · 26 match (11 of them match-by-copy or no-frame) · 2 left · 0 clipping.**
Plus 3 secondary states (Activity tab, drawer, PDP price ladder), all match.

## What this pass closed

1. **Catalog gaps** — `catalog-search-screen.tsx` chips are now `PillButton tone="filter" labelRole="caption"
   uppercase` ("SEALED / SIR / ILLUS. RARE …"); the search placeholder on Search Cards, `game-sets-screen.tsx` and
   `expansion-detail-screen.tsx` is `SearchField uppercasePlaceholder` ("SEARCH BY NAME, SET, OR NUMBER").
2. **`SectionHeader uppercase`** — new opt-in prop (title + action, JS `.toUpperCase()`), documented in
   `packages/design-system/README.md`. Turned on for the catalog "SEALED PRODUCTS / SEE ALL" and "CARDS" headers.
   The feed blocks (TOP TRENDS / PAST 30 DAYS per 5768:27092) and the PDP headers (PRICE TREND / PRODUCT DETAILS)
   were already capitals; the PDP ones were moved from `textTransform` to the string (see sweep).
3. **Activity-tab post cards** — verified on the simulator (`final/states/Portfolio-activity.png`) against
   5938:31069: author SemiBold 16, date `JUL 15, 2026` Overline, FOLLOW / FOLLOWING Caption, counts `labelStrong`.
   Nothing left to fix; the social agent's date + FOLLOW work holds. (5938:31740, the id in the brief, is the
   comments sheet inside that section — "COMMENTS" header, relative times; also consistent with code.)
4. **SalesHistory** had slipped through every earlier pass: toolbar title "Transactions", chips "Recent / Value /
   A-Z / All / Sold / Traded" and the placeholder were sentence-case while every list frame (1874:22334 included)
   sets them in capitals. Now "TRANSACTIONS", filled-tone Caption chips in capitals, "SEARCH TRANSACTIONS".

## iOS clipping sweep (`textTransform: 'uppercase'` → string casing)

iOS measures a `Text` from the untransformed string; a one-line, row-flexed or content-sized label then draws the
wider capitals into a box sized for the source and ellipsizes or clips. Every site below was moved to
`.toUpperCase()` on the string (or a capital literal). Accessibility labels were untouched (they are separate
props); test assertions were updated to the new strings, none deleted.

Design-system primitives (the fix lands everywhere they are used):

| file | what |
|---|---|
| `packages/design-system/src/components/pill-button.tsx` | `uppercase` prop now uppercases the label string; `labelUppercase` style removed |
| `packages/design-system/src/components/page-tabs.tsx` | same for tab labels (COLLECTION / ACTIVITY, FOLLOWERS / FOLLOWING) |
| `packages/design-system/src/components/badge.tsx` | pill badge label |
| `packages/design-system/src/components/screen-header.tsx` | eyebrow |
| `packages/design-system/src/components/text-field.tsx` | field eyebrow ("EMAIL") |
| `packages/design-system/src/components/inventory-card-tile.tsx` | collection meta line ("NEAR MINT", `numberOfLines={1}`) |
| `packages/design-system/src/components/card-list-row.tsx` | collection grade line (`numberOfLines={1}`) |
| `packages/design-system/src/components/section-header.tsx` | new `uppercase` prop is string-based from the start |

App call sites (40 `textTransform` declarations across 29 files):

| file | labels converted |
|---|---|
| `src/features/insights/screens/insights-screen.tsx` | INSIGHTS toolbar title, POKEMON category, "6 ITEMS" |
| `src/features/insights/components/performance-table.tsx` | row subtitle lines (one-line, "REVERSE HOLOFOIL") |
| `src/features/cards/screens/scan-candidate-review-screen.tsx` | redundant style removed (string was already uppercased) |
| `src/features/cards/components/card-configurator.tsx` | option chips (one-line, in a pill) and LANGUAGE / VARIANT / GRADER titles |
| `src/features/cards/components/inventory-dropdown.tsx` | INVENTORY (row with icon) |
| `src/features/cards/components/card-price-trend-list.tsx` | PRICE TREND (row with provider logo), condition rows (one-line) |
| `src/features/cards/components/card-price-trend-skeleton.tsx`, `card-product-details.tsx` | PRICE TREND / PRODUCT DETAILS |
| `src/features/labeling/screens/labeling-session-screen.tsx` | card-number lines, angle chips, "1 OF 4", CAPTURED / MISSING |
| `src/features/profile/screens/follow-list-screen.tsx` | "@HANDLE" (one-line) |
| `src/features/profile/components/profile-header.tsx` | "@HANDLE", "12 FOLLOWERS" stat row |
| `src/features/profile/screens/public-profile-screen.tsx` | MAIN COLLECTION / TOTAL: $… summary row |
| `src/features/profile/screens/edit-profile-screen.tsx` | EDIT PROFILE cover title (one-line) |
| `src/features/inventory/screens/inventory-browser-screen.tsx` | COLLECTION nav title |
| `src/features/portfolio/components/collection-search-row.tsx` | collection name (one-line, in a row with the chevron), TOTAL |
| `src/features/portfolio/components/portfolio-balance-header.tsx` | MAIN COLLECTION eyebrow (one-line) |
| `src/features/portfolio/screens/sales-history-screen.tsx` | TRANSACTIONS title; chips via `PillButton uppercase` |
| `src/features/whos-that-pokemon/components/result-panel.tsx`, `face-lock-on.tsx`, `scanning-theater.tsx` | "91% MATCH" pill, YOU, status captions |
| `src/features/events/components/event-list-card.tsx`, `event-vendors-section.tsx`, `screens/events-screen.tsx`, `screens/event-detail-screen.tsx` | card title / venue / date / hours / city (one-line rows), vendor tags, UPCOMING SPOTLIGHT EVENTS, detail title / rows / tags / PRICING / notes / disclaimer |
| `src/features/meta-feed/screens/meta-screen.tsx` | headline overline |
| `src/features/scanner/screens/scanner-screen.tsx` | SINGLE mode pill, tray printing chip (one-line), CHANGE chip |
| `src/features/scanner/screens/change-card-picker.tsx` | YOUR PHOTO / "71% MATCH" captions |
| `src/features/scanner/components/binder-batch-action-row.tsx` | DONE, VARIANT pill |
| `src/features/scanner/components/scan-bulk-confirm-sheet.tsx` | title, description; buttons via `Button uppercase` instead of `labelStyle` |
| `src/features/scanner/components/scan-target-pill.tsx` | POKÉMON EN (glass pill) |
| `src/features/wishlist/components/wishlist-header.tsx` | WATCHLIST (one-line) |
| `src/components/app-drawer.tsx` | member-since line (one-line), PORTFOLIO VALUE / TOTAL ITEMS tiles, nav labels (icon rows) |
| `src/features/auth/screens/account-screen.tsx` | section titles written as capitals |

Kept as `textTransform` — every remaining site has a **definite width** (full-width column or a fixed column),
so iOS measures the right box:

- `performance-table.tsx` column headers (`width: CELL_W` / `CHART_W`, verified "CURRENT" whole in the capture)
- `expansion-detail-screen.tsx` `cardMeta`, `expansion-cell.tsx` / `game-mosaic-tile.tsx` `meta` (`width: '100%'`, documented in-file)
- `owned-entry-edit-fields.tsx` / `add-to-collection-sheet.tsx` `groupTitle` (full-width column groups)
- `design-system-catalog-screen.tsx` sample rows (full-width catalog column)
- `tokens.ts` `labelLight` (bio placeholder: multi-line, full width; a written bio opts out with `textTransform: 'none'`)

## Per-screen table

| screen | frame | verdict | what was still off → fixed / left |
|---|---|---|---|
| Portfolio | 5938:16740 (+ tabs 5938:16814) | match (copy) | Tabs COLLECTION / ACTIVITY, MAIN COLLECTION eyebrow, 7D…ALL, "MAIN COLLECTION ▾ / TOTAL: $195", chips ALL / LIKES / A-Z / PRICE / UNGRADED, tiles "NEAR MINT" — all as drawn. Copy only: placeholder "SEARCH YOUR PORTFOLIO" vs frame's pasted "SEARCH BY VENDOR OR HOBBY"; FOR SALE tab not built. |
| Portfolio → Activity | 5938:31069 | match | Own post: author SB 16, "JUL 15, 2026", counts; no FOLLOW on own post (frame shows it for another author). Frame also draws a composer at the top of the tab — layout, not type. |
| Portfolio → drawer | none | no frame | PORTFOLIO VALUE / TOTAL ITEMS, nav labels in capitals (converted from `textTransform`). |
| PublicProfile | 5938:32705 | match (copy) | FOLLOW / MESSAGE, stats "1284 FOLLOWERS", written bio sentence-case, tabs, summary row, placeholder — match. Handle "@WABISABI" where the frame draws the person's name "JOHN"; placeholder copy differs. |
| FollowList | 5753:12867 | match | "7 FOLLOWERS / FOLLOWING" tabs, "@KANTOGRADER" Overline (frame: "JOHN" raw Regular 12). |
| EditProfile | 5938:34181 | match | EDIT PROFILE, sentence-case placeholders, "Bio / 0/150", Verify page, CANCEL / SAVE. |
| NewPost | 5938:34243 | match | NEW POST, "WHAT'S ON YOUR MIND?", 0/500, PUBLIC / PHOTO / CAMERA, POST. |
| Feed | 5768:27092 | match | TOP TRENDS / PAST 30 DAYS, author, "JUL 16, 2026", FOLLOW / FOLLOWING, counts. "Pokémon" caption under the title is the frame's small game chip. |
| TopTrends | 5768:27136 / 27152 | match | Same block, standalone route. |
| Scanner | 5753:18575 / 5753:17489 (tray) | match (copy) | POKÉMON EN pill (frame: POKEMON EN, no accent — copy), SINGLE / 1x / 1.5x / 2x, SCAN: 1 / ADD ALL / TOTAL, CHANGE thumb chip, HOLOFOIL printing chip, ADD ITEM. Tray subtitle "Phantasmal Flames · #125/094" vs frame "038/088 · Perfect Order / RAW" — data, not type. |
| ScanReview | none | no frame | "6 cards found", "Closest Match" / "5 similar cards" Title-medium sentence-case (no frame to call for caps), set names in caps. |
| CardDetail | 5768:21988 (+ 5768:22713 graded) | match (copy) | VARIANT / GRADER titles, NORMAL / RAW / PSA / BGS / CGC chips, PRICE TREND, NEAR MINT / LIGHTLY PLAYED ladder (scrolled state), SAVE / SHARE (frame: SAVE / CANCEL — copy). LANGUAGE group hidden by the mock (EN only). "Similar cards" rail has no frame. |
| Wishlist | 5656:9898 | match (copy) | WATCHLIST (frame: WISHLIST — product copy decision), SEARCH YOUR WATCHLIST, chips ALL / A-Z / PRICE / UNOWNED / OWNED, tile "PSA 10 / Holofoil". Deals band: no frame; its compact header stays "Deals". |
| Insights | 5689:18271 | match (copy) | INSIGHTS, POKEMON, "6 ITEMS", chips, PORTFOLIO / GRAPH / CURRENT / $1M G/L (whole, no truncation), row subtitles in caps. Placeholder copy "SEARCH YOUR PORTFOLIO" vs "SEARCH YOUR COLLECTION". "REVERSE HOLOF…" is a `numberOfLines={1}` ellipsis of a long printing name inside the frame's own narrow column, not clipping. |
| SalesHistory | 1874:22334 (future ledger) | **fixed** | Was "Transactions" / "Recent, Value, A-Z / All, Sold, Traded" / "Search transactions" sentence-case → now TRANSACTIONS, filled Caption chips in capitals, SEARCH TRANSACTIONS. Day-grouped BUY / SELL / TRADE ledger itself is unbuilt. |
| Inventory | none | no frame | COLLECTION nav, "View all cards" Display, SORT + RECENT / VALUE / A-Z chips, tiles. |
| Account | none | no frame | COLLECTION DATA / CONTACT & SUPPORT / SAFETY / ALERTS / LEGAL section titles (Sign-in group-label convention, 4255:88478). |
| BlockedAccounts | none | no frame | "Blocked accounts" Display, UNBLOCK buttons (Button uppercase). |
| ChangePassword | none | no frame | CHANGE PASSWORD eyebrow, rules Caption, button. |
| Login | 4255:88306 | match | LOG IN, Email / Password, Continue, Forgot password?, OR, Google / Apple, NEW ACCOUNT, Sign Up, terms footer. |
| Events | 5865:9330 | match | EVENTS / SAVED / PAST EVENTS, UPCOMING SPOTLIGHT EVENTS, ALL / HAWAII / CALIFORNIA, card title / venue / date / city in capitals. |
| Event Detail | 5882:12594 | match | Title, schedule / address / tables rows, category tags, PRICING, notes, disclaimer, BUY TICKETS — all capitals as drawn. |
| Notifications | none | no frame | Body-medium rows, "JUL 16" dates in caps. |
| Messages | none | no frame | Sentence-case names, Label previews; placeholder "Search collectors" sentence-case (no list-frame convention applied — it is a people search, not a card list). |
| Conversation | none | no frame | Bubbles Body, "JUL 15, 11:02 AM" separators. |
| PostDetail | none | no frame | "Post" Title-small; card as Feed. |
| CatalogSearch | none | **fixed** | Chips SEALED / SIR / ILLUS. RARE / FULL ART / SECRET … Caption capitals; placeholder in capitals; sealed row headers SEALED PRODUCTS / SEE ALL / CARDS via `SectionHeader uppercase`. |
| ExpansionBrowser | none | no frame | "Browse Sets" Display, "8 SETS" caps. |
| ExpansionDetail | none | **fixed** | Placeholder SEARCH BY NAME OR NUMBER; "#001/168" meta in caps. |
| DesignSystemCatalog | none | no frame | Demo of the 11 roles; its `labelUppercase` / `captionUppercase` samples stay on `textTransform` (full-width column). |

Screens that are **not** a full match and why:

1. **Portfolio / PublicProfile / Insights / Wishlist / Scanner / CardDetail — copy, not typography.** Placeholder
   strings ("SEARCH YOUR PORTFOLIO" vs the frame's pasted "SEARCH BY VENDOR OR HOBBY"), WATCHLIST vs WISHLIST,
   SAVE / SHARE vs SAVE / CANCEL, POKÉMON vs POKEMON, handle vs person-name under the display name. Casing,
   role and metrics match; these need a product/copy decision, not a type change (designer items 7, 9 below).
2. **SalesHistory** matches the toolbar / chips / placeholder convention now, but the frame is the unbuilt
   day-grouped ledger, so the body cannot be compared.

Not captured (no dev route — unchanged from the earlier audit): **PortfolioImport** (component no longer in the
tree; `design-map.json` entry is stale) and **WhosThatPokemon** (mounts vision-camera and prompts for permission on
mount; the simulator would only capture the prompt). Both had their uppercase sites converted by code read
(`result-panel.tsx`, `face-lock-on.tsx`, `scanning-theater.tsx`); their tests pass.

## Open for designer (deduped against audit-2026-10-18 items 1–11)

Items 1–6, 8, 10, 11 of the earlier audit stand unchanged. Updated:

- **7 (placeholders)** — code now uppercases every list-screen placeholder; the *copy* still disagrees per frame
  ("SEARCH BY VENDOR OR HOBBY" is pasted on Collection, Wishlist, Insights, Transactions, Events-detail). Pick one
  string per screen.
- **9 (casing)** — resolved in code: tabs, chips, dates, FOLLOW, summary rows, option chips, toolbar titles and
  section headers all render in capitals as the frames draw them. Remaining casing questions are copy
  (WATCHLIST / WISHLIST, POKÉMON / POKEMON) and three no-frame headers kept sentence-case: Wishlist "Deals",
  ScanReview "Closest Match / N similar cards", PDP "Similar cards".
- **New:** the Activity tab frame (5938:31069) draws a composer above the posts; the app shows posts only.
- **New:** Insights frame placeholder reads "SEARCH YOUR COLLECTION" while Portfolio's reads "SEARCH YOUR
  PORTFOLIO" (code says PORTFOLIO on both).

## Verification

- `pnpm --filter @spotlight/mobile-app typecheck` — clean (no output); `tsc --noEmit -p packages/design-system` — clean.
- `pnpm test` in `apps/spotlight-rn` — see the hand-off tail (all suites green after updating 28 test files to the
  new string casing; no assertions removed, `getByPlaceholderText` matchers relaxed to case-insensitive regexes).
- eslint on every changed app file: 0 errors (1 pre-existing unused-var warning in `scanner-screen.tsx:1220`).
  `packages/design-system` has no lint script and sits outside the app's eslint base path; covered by tsc.
