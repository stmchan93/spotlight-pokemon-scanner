# TCGCSV Main-Price Migration (2026-08-25)

Supersedes the PPT-based approach in
[japanese-raw-pricing-tcgplayer-source-plan-2026-06-24.md](japanese-raw-pricing-tcgplayer-source-plan-2026-06-24.md)
for the raw main price. The PPT graded-signals side table is unrelated and unchanged.

## What this is, in plain English

The single "main price" the app shows for a raw card used to be Scrydex's resolved
(default-variant, Near Mint) market entry. It now comes from **TCGCSV**
(https://tcgcsv.com — a free daily republication of TCGplayer price data; usage
confirmed allowed by their Discord), specifically TCGplayer's **marketPrice**.
Everything derived from the main price follows it: portfolio totals, new
price-history days, insights, scan tray, day-change, sparkline percentages.

What did NOT move:
- The per-condition matrix (NM/LP/MP/HP prices, the PDP grid, owned-copy
  condition pricing) stays Scrydex.
- Catalog/identity stays Scrydex.
- The entire graded/slab lane stays exactly as it was.
- Per-card fallback: a card with no TCGplayer product match, a null marketPrice,
  or a stale TCGCSV row serves its Scrydex main price. Absence falls back;
  matches are never guessed.

## Storage: the "main lane"

One row per card everywhere, no provider-key migration:
- `card_price_snapshots`: `main_raw_market_price`, `main_raw_low_price`,
  `main_raw_mid_price`, `main_raw_high_price`, `main_raw_direct_low_price`,
  `main_raw_variant` (the TCGCSV subTypeName used), `main_raw_updated_at`.
  TCGCSV-only values; NULL means "no TCGCSV price".
- `card_price_history_daily`: `main_raw_market_price`, `main_raw_variant`.
- `card_price_history_cell`: one cell per card/day, `lane='raw_main'`,
  `cell_key raw_main|<subTypeName>|NM`, provider `tcgcsv`, USD.
  `replace_price_history_cells` deliberately spares this lane so the 18:00
  Scrydex rewrite cannot wipe the 13:05 TCGCSV cell.
- These columns are additive and deliberately NOT in
  `_rebuild_pricing_tables_if_needed`'s required sets.

## Flags

- `TCGCSV_SYNC_ENABLED` (default off) — gates the daily writer.
- `RAW_MAIN_PRICE_SOURCE` = `scrydex` (default) | `tcgcsv` — the read-path kill
  switch. Flip back for an instant revert; data stays intact.
- `TCGCSV_STALE_HOURS` (default 48) — a main value older than this serves
  Scrydex, so a dead sync can never freeze headlines.

## The sync (backend/sync_tcgcsv_prices.py + tcgcsv_adapter.py)

- Cron `5,35 13,14 * * *` America/Los_Angeles (first attempt 1:05 PM PT —
  user-chosen — plus catch-up minutes, because TCGCSV's daily publish finishes
  around ~13:05 PT; well before the 18:00 PT Scrydex sync). Deployed by
  `deploy_to_vm.sh` (`SPOTLIGHT_VM_TCGCSV_SYNC_CRON`) on BOTH environments —
  TCGCSV burns no credits, and the job is dark unless `TCGCSV_SYNC_ENABLED` is
  set in that box's env file (staging has it set for the shadow soak).
- **tcgcsv.com/docs compliance** (their rules, our implementation):
  - "Check last-updated.txt first" / "Limit your pulls to once every 24 hours"
    → the sync fetches `last-updated.txt` and exits (one request) when the
    marker hasn't advanced past `runtime_settings.tcgcsv_last_updated_marker`;
    only the first attempt after a publish does the real crawl.
  - custom User-Agent required → `Spotlight/1.1 (card scanner; contact: ...)`.
  - ≥100ms sleep in the update loop → 300ms enforced inside the adapter,
    strictly sequential, Retry-After honored, exponential backoff, hard abort
    on final failure (never a retry storm — staleness fallback covers a missed
    day).
  - <10,000 requests/24h → ~750/day (categories 3 Pokemon + 85 Pokemon Japan),
    ~5-6 min.
  - server-side ingestion into our own DB (no client-side fetches; SKUs /
    per-condition prices are not offered by TCGCSV and are not used — Scrydex
    keeps conditions).
- Join: `cards.tcgplayer_id` (auto-backfilled if empty) + per-printing product
  ids from the Scrydex payload; `collision_guard` product ids are skipped so a
  Scrydex mis-map can never become a price mis-map.
- Number-verified collision resolution (added same day): when a product id is
  shared by several cards, the sync fetches that group's `/products` list and
  reads the product's card Number from extendedData — if it names exactly ONE
  claimant, that card keeps the price (real case: svp-222's payload mis-points
  at Professor Birch's 664829/#221, which had blocked svp-221 too; 221 now
  prices, 222 stays on Scrydex fallback). Ambiguous/unfetchable → both stay
  blocked. Deliberately NOT extended to re-mapping a mis-pointed card onto a
  different product (needs set↔group inference = wrong-price risk).
- **Trust-but-verify on EVERY join** (added same day, `TCGCSV_VERIFY_NUMBERS`
  default on): the sync also fetches every group's `/products` (~+380 req/day,
  total ~1,130) and requires the product's own card Number to agree with the
  card before pricing it — a wrong-but-unique Scrydex product id now fails
  CLOSED (Scrydex fallback) instead of silently pricing the wrong card, with
  suspects logged in the sync-run notes (`numberMismatchSuspects`). Measured
  2026-08-25 before enforcement: 99.9% verified (EN 20,485✓/25✗, JP
  11,455✓/2✗); after normalizer tuning ("SVP 175" prefixes, "h01" zero-pad),
  real skips ≈ 6 cards — two genuine mis-maps (swsh8a_ja-27 Pikachu V-UNION
  #27→product #28; sm1s_ja-43 Kangaskhan #43→#42) and Aquapolis "50a"-style
  letter variants, which deliberately fail closed. Products with no parseable
  Number (or numberless cards like Ancient Mew) are unverifiable and price
  normally. Normalizer + match rule live in `tcgcsv_adapter.py`
  (`normalized_card_number`, `card_numbers_match`), mirrored in the audit
  script so measurement always equals enforcement. A CONFIRMED mismatch also
  CLEARS any previously-written main lane for that card (snapshot columns,
  today's daily columns, today's raw_main cell) — a known-bad join must not
  keep serving until the staleness window expires. First verified staging run
  (2026-08-25, `--force`): 34,548 priced / 7 mismatch-skips / 17 collisions
  resolved / 1,365 requests; live suspects = 4 Aquapolis letter-variants +
  swsh8a_ja-27 (V-UNION quarter) + sm1s_ja-43 (off-by-one) + tk6b-12
  (#12→product #23). `--force` flag exists for manual validation runs only
  (bypasses the last-updated guard; keep rare).
- **Manual overrides** (`backend/data/tcgplayer_id_overrides.json`, confirmed by
  Stephen 2026-08-25): human-verified card→product remaps that replace the
  Scrydex payload claim and are exempt from collision blocking and number
  verification. Nine entries: svp-222→664827 (Kukui), swsh8a_ja-27→571819
  (V-UNION Bottom Left), sm1s_ja-43→573257, tk6b-12→98007 (the kit's other
  Noibat), dp6-71→89534 (Starmie's own product), and the four Aquapolis
  letterless-number cards pinned to their "a" products. Add future confirmed
  mis-maps here — permanent, survives every sync.
- **Collision attribution rules** (in order): one Number match → that card;
  several Number matches with the SAME name → all of them (trainer-kit twins:
  one TCGplayer product covers both kit halves); different names → the card
  whose name appears in the product's own name, if exactly one does. Still
  ambiguous → blocked.
- **Fallback policy decision (2026-08-25): Scrydex fallback KEPT for now**
  (user leaning toward dropping it — possibly JP-only — but deferred until
  after the staging soak; revisit at flip time). Motivating example: the
  Poncho-wearing Pikachu Rayquaza promos (smp_ja-37/38) have TCGplayer
  products but no listings → no TCGCSV price → today they fall back to
  Scrydex's broken ¥330,000/$280,000; under JP-blank they'd show "—".
- **Failure tolerance** (three layers): per-request retries with backoff and
  Retry-After; per-GROUP tolerance — a group whose fetch exhausts retries is
  skipped and logged (`failedGroups` in notes, its cards keep yesterday's main
  via the staleness window) rather than aborting the other ~380 groups, with a
  >40-failed-groups abort for "TCGCSV is down"; and whole-DAY retry — the
  publish marker is stored only after a fully clean crawl, so the catch-up
  cron attempts (`5,35 13,14,16,20 * * *` PT; 18-19h skipped for the Scrydex
  sync) automatically re-crawl a failed or partial day.
- Subtype selection: card's default variant label → subTypeName (Normal,
  Holofoil, Reverse Holofoil, First Edition→1st Edition Holofoil,
  Unlimited→Unlimited Holofoil), then the fixed TCGplayer subtype order.
  Only `marketPrice > 0` entries are accepted.
- Writers only touch main-lane columns; on an existing Scrydex snapshot row the
  provider/default_raw_*/context columns are byte-identical after a run.
- Bookkeeping: `provider_sync_runs` (provider `tcgcsv`, scope `raw-main`);
  bumps `runtime_settings.pricing_sync_generation`, which the portfolio
  dashboard/deck-entries cache tokens include (fixes both the double-invalidate
  and the same-price_date-miss cache bugs).

## The read path (flag-gated, backend-only, zero OTA)

Per-card rule: fresh `main_raw_market_price` → serve TCGCSV; else exactly the
old Scrydex behavior. "Default read" = requested condition None/NM AND requested
variant None/matching `main_raw_variant`.

- Headline seams: `_pricing_summary_from_snapshot_row` (server.py) and
  `price_snapshot_for_card` (catalog_tools.py). Served summary: TCGCSV numbers,
  `currencyCode "USD"`, `condition "NM"` (never null — this keeps the RN
  client's condition gate behaving identically, so owned LP/MP copies keep
  their Scrydex condition price), `variant` = main variant, plus
  `mainPriceSource: "tcgcsv" | "scrydex"` (diagnostics only; UI does not
  caption it — user decision).
- History/day-change/sparklines/dashboard: per-row COALESCE onto
  `main_raw_market_price` for default raw reads only (LP/variant-scoped rows
  keep like-for-like Scrydex diffs).
- `_card_volume_level` counts the COALESCEd value (condition-picker gating).
- `portfolio_insights` scalar read tries the main lane first.
- Phantom guard (raw > own PSA 10) evaluates the value actually served;
  single-printing gate unchanged (Scrydex variant cardinality).
- **Condition-surface coherence** (2026-08-26, user-approved, flag-gated like
  the headline): on the raw-pricing-matrix (scan price sheet) and the
  price-trends raw rows, the NM cell of the printing the main price belongs to
  serves the main lane's values (TCGplayer's product-level marketPrice has NO
  condition dimension — SKU/condition prices exist but TCGCSV doesn't publish
  them; market≈NM is the same approximation TCGplayer's own page makes). A
  same-printing non-NM Scrydex row is HIDDEN when it exceeds 2× the main price
  (kills broken-JP rows; margin `_MAIN_CONDITION_SCALE_MARGIN=2.0`). Other
  printings are never judged (phantom-guard lesson: high-value parallels are
  legit) — so a JP card's other printings can still show Scrydex-scale rows;
  the fix for that, if ever wanted, is persisting ALL subtype prices.
- **Trend graphs on main-lane points** (2026-08-27, user decision): the NM
  series on all three graph surfaces (PDP market-history chart, per-condition
  trend list points + trendPct, condition-history series) merges per-day:
  a date with a raw_main cell uses the TCGCSV value; older dates keep Scrydex.
  NO backfill — the mixed series is intended, and the TCGplayer share grows
  one day per sync (started 2026-08-25). Covers every printing with main-lane
  cells; LP/MP series and no-sales printings untouched; flag-gated. Shared
  reader: `catalog_tools.main_raw_cell_points_by_variant_date` (one query per
  card window). If a full-history single-source curve is ever wanted, TCGCSV
  archives reach back to 2024-02-08 (a deliberate one-off backfill job, not
  built).
- **Per-printing prices** (2026-08-26): the sync now persists EVERY printing's
  TCGCSV row that has marketPrice>0 in `card_price_snapshots.
  main_raw_printings_json` (keyed by Scrydex label, exact label→subTypeName
  mapping — no fallback walk; same collision/number-verification rules) plus
  one `raw_main` cell per priced printing. The condition surfaces apply
  Rule 1/Rule 2 per printing found in that map. Printings with NO TCGplayer
  sales are ABSENT from the map and keep their Scrydex rows verbatim —
  explicit user decision (Blastoise Unlimited stays ¥50,000→$307.97; the $185
  ask floor and blanking were both considered and rejected).

## Known/accepted consequences

- Since-added baselines are NOT re-baselined. Existing positions see a one-time
  step equal to the Scrydex↔TCGplayer delta on flip day (EN typically small;
  JP corrects a known-wrong number). Re-baselining would destroy real
  gain/loss history.
- `scan_price_observations` rows keep their original `pricing_source`.
- Parity audit artifact (2026-08-25, tools/audit_tcgcsv_parity.py on a stale
  local DB — re-run on staging before any flip): EN coverage 99.7%
  (20,519/20,580), JP 57% priced + 43% Scrydex fallback, 22 colliding product
  ids, 92% exact subtype matches, 261 JP cards gain a price.

## Rollout

1. Deploy backend to staging. Run `sync_tcgcsv_prices.py` manually with
   `TCGCSV_SYNC_ENABLED=1` for ≥2 days (shadow days kill the flip-day
   day-change spike). Re-run the parity audit against staging.
2. Flip `RAW_MAIN_PRICE_SOURCE=tcgcsv` on staging; soak ≥3 days; eyeball: PDP
   headline vs matrix, JP card USD headline + converted grid, owned LP copy
   unchanged, wishlist caption, scan tray total, portfolio continuity,
   sparkline % vs headline agreement.
3. Production (explicit approval + `SPOTLIGHT_PROD_CONFIRM` per invocation):
   backfill + collision audit, enable sync, ≥2 shadow days, flip the flag.
   Revert at any point = flip the flag back.

## Tests

`backend/tests/test_tcgcsv_adapter.py`, `test_sync_tcgcsv_prices.py`,
`test_main_raw_price_serving.py` (+ additions to `run_all_tests.sh`). The full
curated gate (816 tests) passes with the flag off AND on; the cells/JSON parity
harnesses pass both ways.
