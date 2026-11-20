# Search with set progress: plan (2026-11-20)

Status: AGREED WITH USER, NOT BUILT. Figma: sets list `6552:1913` (same as `6430:4910`), set page `6425:3296`.
Supersedes the scope decisions in `set-completion-tracking-plan-2026-07-16-DEFERRED.md` where they differ (that plan showed only sets you own; this one shows every set).

## Plain English

Search becomes a way to see how close you are to finishing every set.

**Sets list** (replaces the game grid → sets flow)
- Chips across the top pick the game (Pokémon, One Piece, Disney Lorcana, …). Every game, every set, newest first, including sets at 0%.
- Each set card: logo, name, release date, a progress bar, "84 of 135 CARDS", and the percent.
- The search box still searches **cards** in that game, and typing a set's name finds that set's cards (works today).
- Sparkle button top right = the AI assistant (wired to the same entry point as everywhere else; if the assistant isn't live yet, the button is hidden rather than dead).

**Set page**
- Set logo, then a header card: set name, release date, progress bar, "X of Y CARDS", percent, and **TOTAL VALUE = what the whole set is worth** (every card at its Near Mint price), not just your copies.
- Search box (cards in this set) and rarity chips (All, then only the rarities this set actually has: e.g. HR, SIR, IR, Ultra Rare).
- 2-column grid of every card in the set. Cards you don't own are **faded**. No "missing" label.
- Each card has **− QTY +**:
  - **+** adds one copy: the card's default printing, Near Mint, raw.
  - **−** removes one copy. If you own the card in more than one form (two printings, a raw copy and a slab), a small sheet asks which one. No guessing.

## Rules (decided)

| Question | Decision |
|---|---|
| What counts as owning a card | Any printing of that card number, raw OR graded, any condition, quantity ≥ 1 |
| The total ("of Y") | Every card in the set **including secret rares** (cards numbered past the printed total) |
| Which sets show | All sets in all games |
| Search box | Searches cards; set names match |
| + adds | Default printing, Near Mint |
| Total value | Value of the FULL set, not your copies |
| Graded slabs | Count toward completion |
| Missing cards | Faded, no label |

## What has to be built

| Piece | Where | Size |
|---|---|---|
| Per-set progress for the signed-in user (owned card count per set) added to the sets list | backend | small |
| Per-set totals: card count (secret-inclusive) and full-set value, cached and refreshed after the nightly price sync | backend | small |
| Set page header data (same numbers for one set) | backend | small |
| Add/remove one copy from the set grid (reuses the existing collection endpoints) | backend: none new, maybe one helper | small |
| `ProgressBar` primitive (none exists yet) | design system | small |
| Sets list screen with game chips + set cards | RN | ~1 day |
| Set page: header card, rarity chips, faded grid, QTY stepper, "which copy?" sheet | RN | ~1.5 days |
| Dev-screen routes + mock data for `/sync-design` against the Figma frames | RN | small |

About **3–4 days** total. Zero Scrydex credits: every number comes from our own database.

## Edge cases

- **Sets with no price for some cards**: total value sums the cards that have a price; the header doesn't claim more precision than it has.
- **Japanese sets**: their own rows with their own totals, as today. Values are USD only (never show yen).
- **Guests**: progress shows 0%; tapping + asks them to sign in, same as other add-to-collection buttons.
- **Speed**: the per-user count is one grouped query over the user's collection; set totals and values are precomputed, not summed per request.

## Appendix: technical notes

- Owned per set: `deck_entries` (owner-scoped via `owner_user_id`, quantity > 0, raw or graded) JOIN `cards` ON `cards.id` GROUP BY `cards.set_id` → COUNT(DISTINCT card_id). Owner scoping per the cross-account rule.
- Denominator: COUNT of `cards` rows per `set_id` (the same cards the grid shows, so "of Y" always equals what you can scroll), cross-checked against `source_payload_json → expansion.total`.
- Full-set value: SUM of each card's served main price (TCGCSV main lane, Scrydex fallback, default printing, NM) — the same price the card page shows. Cache keyed on the pricing generation.
- Expansions endpoint (`useGameExpansions`) gains `ownedCount`, `totalCount`, `setValue`; `listCardsInExpansion` already returns `ownedQuantity` per card.
- Rarity chips: from the server-owned rarity buckets in `catalog_tools` (`RARITY_BUCKET_KEYS`), showing only buckets present in the set. Figma's "HR" (hyper rare) needs a label mapping onto the existing buckets.
- Existing screens to evolve: `expansion-browser-screen.tsx` (game grid → game chips), `game-sets-screen.tsx` (set cards), `expansion-detail-screen.tsx` (set page).
