# PSA Grade Pricing Spec

Status: Active
Date: 2026-04-03

## Goal

Add a real `PSA-grade pricing` lane to Spotlight so PSA slab scans stop pretending raw-card prices are the final answer.

The target is not a native marketplace. The target is:

- identify the exact slab quickly
- show the best available PSA-grade value quickly
- explain how that value was derived
- improve the estimate as better slab comp data arrives

## Product Principles

1. `Exact slab sales beat everything else.`
2. `Raw-card pricing is not slab pricing.`
3. `If slab pricing is modeled or thin, say so explicitly.`
4. `The scanner row should still resolve fast.`
5. `Raw and slab pricing must be separate lanes.`

## Card-Ladder-Style Shape

We are following the published shape of Card Ladder's pricing model, adapted for Pokemon slabs:

- use a database of historical sales
- anchor today's estimate to those stored sales
- prefer exact same card + exact same grade
- if exact comps are sparse, use nearby grades of the same card
- if that is still sparse, use a broader market bucket to infer market movement
- expose confidence

For Pokemon slabs, the best anchor order is:

1. exact same card, exact same grade
2. same card, nearby grades
3. broader Pokemon bucket
4. raw price only as a labeled fallback

## Pricing Tiers

### Tier 1: `exact_same_grade`

Use actual sold comps for:

- same `card_id`
- same `grader`
- same `grade`

Example:

- `neo1-9`, `PSA`, `10`

Output:

- market estimate from exact slab comps
- comp count
- last exact sale
- confidence based on recency and comp count

### Tier 2: `same_card_grade_ladder`

If exact same-grade comps are too thin, estimate from nearby grades of the same card.

Example:

- price `PSA 10` from recent `PSA 9` and `PSA 8` comps of the same card

This is the closest Pokemon equivalent to Card Ladder's `Grade Ratio Value`.

Output:

- modeled grade estimate
- supporting nearby grades used
- confidence lower than exact same-grade

### Tier 3: `bucket_index_model`

If exact same-card data is still too thin, anchor the card's last exact sale to a broader Pokemon bucket.

Bucket examples:

- same set + rarity
- same iconic Pokemon + slab grade segment
- same alt-art / gold star / e-reader holo class

Formula shape:

`estimated_now = target_last_sale * (current_bucket_index / bucket_index_on_target_sale_date)`

Output:

- modeled estimate
- bucket key used
- confidence lower than same-card grade ladder

### Tier 4: `raw_fallback`

If no useful slab comps exist, show raw-card pricing only as:

- `Raw proxy`
- never as `PSA market`

## Data Model

### `slab_sales`

One row per known sold slab comp.

Required fields:

- `card_id`
- `grader`
- `grade`
- `sale_price`
- `currency_code`
- `sale_date`
- `source`

Useful fields:

- `source_listing_id`
- `source_url`
- `cert_number`
- `title`
- `bucket_key`
- `accepted`
- `sale_payload_json`

### `slab_price_snapshots`

One row per currently computed slab price.

Key:

- `card_id`
- `grader`
- `grade`

Fields:

- `pricing_tier`
- `currency_code`
- `market_price`
- `low_price`
- `high_price`
- `last_sale_price`
- `last_sale_date`
- `comp_count`
- `recent_comp_count`
- `confidence_level`
- `confidence_label`
- `bucket_key`
- `methodology_json`
- `updated_at`

## API Behavior

### Scanner match

If the scan resolves as a PSA slab and a grade is parsed from the label:

- return `resolverMode = psa_slab`
- return `slabContext`
  - grader
  - grade
  - cert number if available
- return slab pricing in the candidate `pricing` field when a snapshot exists
- otherwise keep raw pricing available only as a fallback

### Card detail / refresh

Card detail and refresh must accept pricing context:

- `grader`
- `grade`

If slab pricing exists for that context, return it.

If not:

- return raw snapshot only as `raw_fallback`

## UI Behavior

### Compact row

If slab pricing exists:

- show `PSA 10 Market` or equivalent compact primary label
- show confidence / freshness

If slab pricing is missing:

- show `Raw proxy`
- do not imply the price is slab-accurate

### Expanded row

Show:

- primary price
- tier used
- last sale
- comp count
- freshness
- confidence

## Initial Implementation Scope

The repo should implement:

1. PSA grade parsing from label OCR
2. slab sales table
3. slab price snapshots table
4. snapshot recompute engine
5. API support for grade-aware pricing
6. scanner UI support for slab pricing vs raw proxy
7. tests

The repo does not yet need:

- multi-source live marketplace ingestion
- push notifications
- non-PSA graders

## Current Source Reality

Today, raw-card pricing in the repo comes from imported Pokemon TCG API card payloads and prefers `tcgplayer`.

For PSA v1, the active current-value refresh lane is now `Scrydex`:

- identify the slab
- resolve the local card
- refresh a grade-aware snapshot from Scrydex when credentials are configured
- write that into `slab_price_snapshots`
- return it as normal `psa_grade_estimate` pricing

This is a provider-snapshot path, not a historical comps engine, and the local slab-comp model remains the fallback when Scrydex is unavailable or has no exact graded value.

The repo now also has the first slab-comp source-sync path:

- `PSA Auction Prices Realized` HTML / local export ingestion
- manifest-driven source config
- scheduled sync runner

See:

- [psa-slab-source-sync-spec-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/psa-slab-source-sync-spec-2026-04-03.md)
