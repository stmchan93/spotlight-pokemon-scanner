# Watch per printing + honest deals (2026-09-24)

Decided with the user. Motivating case: watching Dragonite 2/146 (Legends Awakened) stored the HOLOFOIL price
($217.25); two eBay REVERSE HOLO listings ($95, $129.99) were alerted as 56% / 40% off. TCGplayer's reverse-holo
"market" ($184.10) had been frozen for a week while copies listed at $90–$135 — a thin market.

## Decisions

1. **Watch a specific printing (option A):** a watch is (user, card, printing). A user may watch several printings
   of the same card (Holofoil AND Reverse Holofoil = two watchlist rows). Nothing is ever un-watched implicitly.
2. **Card page:** the Watch icon reflects the printing currently selected in the PDP variant picker. If the user
   watches a different printing of this card, show a small tappable line "You're watching the Holofoil" (or
   "…Holofoil and 1st Edition") that switches the picker to it.
3. **Listings must match the printing.** A listing whose title says "Reverse Holo" only compares against a
   Reverse Holofoil watch; for a Holofoil/Normal watch such listings are skipped (and vice versa for "1st Edition",
   existing logic). Unknown printing in title → only eligible when the card has a single printing.
4. **Liquidity tiers** (per printing where data allows):

   | Tier | Rule | Label | Deal needs |
   |---|---|---|---|
   | often | ≥ 10 eBay ungraded sales in 30 days (PPT) | — | ≥ 10% under yardstick AND cheaper than the lowest current TCGplayer listing for that printing |
   | fewer | 5–9 sales in 30 days | "Fewer sales" | ≥ 20% |
   | rarely | 1–4 sales in 90 days, OR TCGplayer market unchanged ≥ 7 days while the lowest listing is ≥ 30% under it | "Few sales" | ≥ 25% AND the cheapest listing |
   | none | no sales data and no usable TCGplayer signal | "Not enough sales to judge" | never a % deal |

   Yardstick = min(printing market price, PPT ungraded median sold when ≥ 3 sales). When PPT sales data is absent
   (e.g. staging, which has no PPT downloads) the tier comes from the TCGplayer-only signals.
5. **New alert kind "new_low":** "Your {card} · {printing} is listed at $95 — the lowest we've seen (usually $129+)".
   No % claim; allowed in every tier including `none`. "Lowest we've seen" = below the lowest TCGplayer low price
   for that printing over the last 30 days and below any listing we've alerted on before.
6. Existing guardrails stay: too-good suppression (≥ 60% under), price floor, daily cap, re-arm, and the market-alerts
   limiter (1 push/day, quiet hours).

## Contract

- Printing key: the TCGplayer printing label used in `card_price_history_cell` lane `raw_main` `variant_key`
  (e.g. `Holofoil`, `Reverse Holofoil`, `Normal`, `1st Edition Holofoil`). Stored as `variant_key TEXT NOT NULL DEFAULT ''`;
  `''` means "the card's main printing" (sealed products and legacy rows). API exposes it as `watchVariant: string | null`
  (`''` → null).
- `card_favorites` primary key becomes (owner_user_id, card_id, variant_key). Migration: rebuild the (small) table,
  existing rows get `variant_key = ''` (main printing) — behaviour for them is unchanged.
- Endpoints stay; add an optional `variant` (body field / query param) to add, remove, target set/clear; omitted = main
  printing, so older app builds keep working unchanged. `GET /api/v1/card-favorites` returns one entry per watch with
  `watchVariant`, and `marketPrice` for THAT printing. `added_market_price` is captured for that printing.
- `CardFavoriteEntry` (packages/api-client types.ts) gains `watchVariant: string | null` and
  `watchKey: string` (`${cardId}|${watchVariant ?? ''}`) used as the list key. Card detail's favorite state gains
  `watchedVariants: string[]` (printings of this card the user watches; '' for main).
- Deal alerts gain `variantKey`, `tier` ('often'|'fewer'|'rarely'|'none'), `tierLabel` (string|null), and `kind`
  may be `'new_low'` (with `lowestSeenCents`, no `discountPct`).
- Market-alert price moves and targets use the watched printing's price.
