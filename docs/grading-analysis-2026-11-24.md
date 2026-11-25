# "Worth grading?" analysis (2026-11-24)

Backend: `backend/grading_analysis.py` (math, fee-file loader, summary, cache) and
`SpotlightScanService.card_grading_analysis` + the route in `backend/server.py`.
Tests: `backend/tests/test_grading_analysis.py`.

## Contract

`GET /api/v1/cards/{cardId}/grading-analysis?variant=<printing label, optional>&grader=PSA`

Public, like the other card reads.

- `400`: `grader` is anything other than PSA (the default is PSA).
- `404`: unknown card.
- `204`: no USD raw Near Mint price, or no USD PSA 10/9/8/7 price, for the card/printing,
  or the fee file is missing or unusable (never a guessed fee).
- `200`:

```json
{
  "cardId": "…", "grader": "PSA", "variant": "Holofoil" | null, "currencyCode": "USD",
  "rawPriceUsd": 50.0,
  "tier": {"name": "Standard", "feeUsd": 59.99, "valueCapUsd": 1000.0 | null, "turnaroundText": "~90–100 business days"},
  "shippingUsd": 39.99, "totalCostUsd": 99.98,
  "outcomes": [{"grade": "10", "priceUsd": 400.0, "netUsd": 300.02, "gainVsRawUsd": 250.02, "worthIt": true}, …],
  "breakEvenGrade": "9" | null,
  "verdict": "worth_it" | "only_at_10" | "not_worth_it",
  "summary": "2-3 plain sentences",
  "summarySource": "ai" | "rules",
  "pricesAsOf": "<card_price_snapshots.updated_at>" | null,
  "feesAsOf": "<fee file as_of>",
  "feesSourceUrl": "<fee file graders.PSA.source_url>"
}
```

## Prices

No provider calls. Both prices come from `card_price_trends` (the route behind
`GET /api/v1/cards/{id}/price-trends`), so they are the numbers the card page shows:

- raw = the `NM` row of `mode=raw` for the printing (TCGCSV main-lane overlay applied;
  a phantom-suppressed NM row has no price, so the result is 204);
- graded = the `PSA <grade>` rows of `mode=graded&grader=PSA` for the printing (cached
  eBay recent-sales average when present, else the stored provider market).

Both have already been converted to USD with stored FX rates. A row still not in USD
(no FX rate stored) is ignored, so no other currency is ever returned. Half grades are
ignored; outcomes are PSA 10, 9, 8, 7 where priced, best first.

## Math

- `totalCostUsd = tier.feeUsd + shippingUsd`
- `netUsd = priceUsd − totalCostUsd`
- `gainVsRawUsd = netUsd − rawPriceUsd`; `worthIt = gainVsRawUsd > 0`
- No selling fees.
- `breakEvenGrade` = the lowest grade with `worthIt`.
- `verdict`: no grade worth it → `not_worth_it`; only PSA 10 → `only_at_10`; a grade
  below 10 also worth it → `worth_it`.
- Tier and shipping come from the fee file (next section).

## Fees: `backend/data/grading_fees.json`

The fee file is the single source of truth and is updated by hand. It is also read by
`mcp_server/grading_fees.py`, and there is no fee table in code.
`grading_analysis.load_psa_fees()` parses it once and parses it again only if the file's
mtime changes. `SPOTLIGHT_GRADING_FEES_PATH` points it at another file, which the tests use.
If the file is missing, isn't valid JSON, has no usable PSA tiers or has no `shipping_usd`,
the response is 204.

- **Tiers:** only `graders.PSA.tiers` entries that are open (`available` is not false) and
  usable by one card (`min_cards` is 1 or less). `other_tiers`, which holds paused tiers
  such as Value, is never used. Each tier's price is `price_usd` and its turnaround is
  `turnaround_business_days`, shown as "~90–100 business days".
- **Tier choice:** the cheapest tier whose `max_declared_value_usd` is at least the PSA 10
  price (a null cap means unlimited). Without a PSA 10 price the best priced grade is used.
  If no tier's cap is high enough, the highest open tier is used.
- **Shipping:** the file's `shipping_usd` (a product default for the trip to PSA) plus PSA's
  published one-card return fee for the declared value, taken from
  `return_shipping.domestic_cards_up_to_<cap>_insured_usd["1-4"]`. Above the largest cap,
  the largest cap's fee is used. If no return fee is published, shipping is `shipping_usd`
  alone. `GRADING_SHIPPING_USD` replaces the whole shipping figure.
- `feesAsOf` is the file's `as_of`. `feesSourceUrl` is `graders.PSA.source_url`.

With the file as of 2026-11-21, a card with a $400 PSA 10 gets Standard: $59.99 fee,
$20 inbound plus $19.99 return shipping, $99.98 in total, ~90–100 business days.

## Summary

Claude writes the summary through `anthropic_adapter.anthropic_messages_request`, the same
urllib client and `ANTHROPIC_API_KEY` that the Who's That Pokémon feature uses. The model is
`claude-haiku-5-5`, the assistant's default, and `GRADING_ANALYSIS_MODEL` overrides it.
Claude receives only the computed numbers and the card's name, set, number and printing. The
call has a hard 8s timeout.

The rules-based summary is used instead (`summarySource: "rules"`) when:

- no API key is set;
- the call raises an error or times out;
- the reply is empty or longer than 3 sentences;
- the reply mentions %, odds, chance, probability, yen or JPY, or contains markdown.

## Cache, logging, cost

- An in-memory cache, bounded to 2,000 entries, holds the full response. The cache key is
  (cardId, printing, UTC day, fingerprint of prices + tier + feesAsOf), so a price or fee
  change misses the cache.
- A response with an AI summary is kept for the rest of that UTC day. A rules response from
  a failed AI call is kept for 10 minutes, then the AI is tried again.
- Each request logs a `grading_analysis_request` event with `outcome`, `cardId`, `variant`,
  `cacheHit`, `summarySource` and `elapsedMs`.
- Cost: one small-model call per card, printing and day, made only when someone taps.
  Each call is about 600 input tokens and at most 220 output tokens, so a fraction of a cent.
