# Price-History Normalization — Migration Plan & Design (2026-06-09)

## Plain-English summary

Today, the price-history table (`card_price_history_daily`) stores, for **every card every
day**, two fat JSON blobs: one with the price of every raw *variant × condition*, one with
every *grader × grade*. That's ~5 KB/row × 2.3 M rows ≈ **11 GB of an 15.5 GB database**,
growing ~150 MB/day. It forces JSON parsing on every read, lives in SQLite overflow pages
(the cold-read I/O that caused the 22 s dashboard timeout), and — the real product problem —
**makes per-condition and per-grade history impossible to query**. You can't ask "chart this
card's PSA 9 over the last year" without parsing 365 blobs.

This plan **normalizes** that data: one tiny row per *price cell* — `(card, date, lane,
variant, condition | grader, grade) → {low, market, mid, high, directLow, trend}`. Per-condition
and per-grade history become first-class indexed queries, the database shrinks ~12×, daily
growth drops ~8×, and the JSON parsing / cold-I/O problems disappear at the source.

### Have vs need

- **Have:** one JSON-blob row per `(card_id, price_date)` in `card_price_history_daily`,
  written by a single upsert in `catalog_tools.py` (with *merge* semantics), read in ~9 places
  in `server.py`/`catalog_tools.py`. A working portfolio dashboard (now cached) that resolves
  each holding's price by parsing those blobs.
- **Need:** a normalized `card_price_history_cell` table (the full matrix as rows), the daily
  sync writing cells, a one-time backfill of the 2.3 M existing rows → ~24 M cells, the readers
  switched to cells **with proven price-for-price parity**, the JSON columns dropped to reclaim
  ~11 GB, and new per-condition / per-grade history endpoints + UI built on the new shape.

### Measured numbers (sampled from the live staging DB, 2026-06-09)

| | Now (JSON blobs) | Normalized (cells) |
|---|---|---|
| Rows in history table | 2.26 M | ~24 M (×10.6 cells/row avg; p95 23, max 46) |
| Storage | 15.5 GB | ~1.3 GB + indexes (~few hundred MB) |
| Daily growth | ~150 MB/day | ~18 MB/day |
| Per-read cost | parse a ~5 KB blob | read only the needed cells, no parse |
| Per-condition / per-grade history | parse 365 blobs | one indexed range query |

The row count multiplies ~10×, but each row is ~55 bytes of numbers instead of a 5 KB blob,
so storage *shrinks*. SQLite handles tens of millions of small indexed rows comfortably; the
whole table fits in page cache, which is what removes the cold-I/O risk.

---

## Target schema

### New table: `card_price_history_cell`

```sql
CREATE TABLE card_price_history_cell (
    card_id        TEXT NOT NULL,
    provider       TEXT NOT NULL,
    price_date     TEXT NOT NULL,            -- ISO date 'YYYY-MM-DD'
    lane           TEXT NOT NULL,            -- 'raw' | 'graded'
    cell_key       TEXT NOT NULL,            -- stable identity within (card_id, price_date) — see below
    variant_key    TEXT,                     -- e.g. 'holofoil' (both lanes carry a variant)
    condition      TEXT,                     -- raw lane: 'NM','LP',... ; graded: NULL
    grader         TEXT,                     -- graded lane: 'PSA','TAG',... ; raw: NULL
    grade          TEXT,                     -- graded lane: '9','10',... ; raw: NULL
    is_perfect     INTEGER NOT NULL DEFAULT 0,
    is_signed      INTEGER NOT NULL DEFAULT 0,
    is_error       INTEGER NOT NULL DEFAULT 0,
    currency_code  TEXT,
    low            REAL,
    market         REAL,
    mid            REAL,
    high           REAL,
    direct_low     REAL,
    trend          REAL,
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (card_id, price_date, cell_key)
) WITHOUT ROWID;
```

- **`cell_key`** is a deterministic string identity so upserts are stable and idempotent:
  - raw: `raw|<variantKey>|<condition>`  → e.g. `raw|holofoil|NM`
  - graded: `graded|<grader>|<grade>|<variantKey>|p<0/1>s<0/1>e<0/1>`  → e.g.
    `graded|PSA|9|holofoil|p0s0e0` (graded grades hold a *list* of entries that can differ by
    variant and the perfect/signed/error flags, so those are part of identity).
- **`WITHOUT ROWID`** clusters rows by the primary key `(card_id, price_date, cell_key)`, so a
  card's cells for a date are physically contiguous — sequential reads, not the random
  overflow-page seeks we have today.
- The price fields (`low/market/mid/high/direct_low/trend/currency_code`) are exactly the leaf
  fields in today's JSON cells (verified against the live structure — see Appendix A).

### Indexes (tune with EXPLAIN QUERY PLAN against real queries before finalizing)

```sql
-- Portfolio dashboard: a holding's price over a date window (raw lane)
CREATE INDEX idx_cell_raw_lookup
    ON card_price_history_cell (card_id, variant_key, condition, price_date)
    WHERE lane = 'raw';
-- Portfolio dashboard / graded holdings
CREATE INDEX idx_cell_graded_lookup
    ON card_price_history_cell (card_id, grader, grade, variant_key, price_date)
    WHERE lane = 'graded';
-- Latest snapshot date (dashboard cache version token; PDP "current" reads)
CREATE INDEX idx_cell_card_date ON card_price_history_cell (card_id, price_date);
-- Top-movers day-over-day diff
CREATE INDEX idx_cell_date ON card_price_history_cell (price_date);
```

### What happens to `card_price_history_daily`

It stays as a **slim header** — one row per `(card_id, price_date)` — keeping the `default_raw_*`
columns (already used as the headline / fallback price) and `display_currency_code`, but
**dropping `raw_contexts_json`, `graded_contexts_json`, `source_payload_json`, `source_url`**
(the ~11 GB) in the final phase. Readers that only need the default/market price keep using the
header (cheap); readers that need a specific condition/grade use the cell table.

---

## Migration phases (each reversible until Phase 5)

### Phase 0 — Review (this doc)
Agree the schema, `cell_key` scheme, and parity bar. No code.

### Phase 1 — Additive schema (safe, reversible)
Add `card_price_history_cell` + indexes via the existing schema-patch path in `catalog_tools.py`
(`_apply_*_schema_patch`). Nothing reads or writes it yet. **Rollback:** `DROP TABLE`.

### Phase 2 — Dual-write (reversible)
In the sync writer (`catalog_tools.py` upsert, ~L3582), after writing the JSON row, **decompose
the `merged_raw_contexts` / `merged_graded_contexts` into cells and upsert them** (one
`executemany` per card/date, `ON CONFLICT(card_id, price_date, cell_key) DO UPDATE`). Going
forward both shapes stay in lockstep. Preserve the existing **merge** semantics (a graded-only
update must not delete the card's raw cells, and vice-versa) — upsert per cell, and delete cells
only when a lane is explicitly replaced. **Rollback:** stop writing cells; JSON is still source
of truth.

### Phase 3 — Backfill (reversible; idempotent)
One-time, resumable job (`tools/backfill_price_history_cells.py`): stream
`card_price_history_daily` in `price_date` (or rowid) chunks, parse each row's JSON, upsert the
cells. Idempotent via `cell_key`, so it can be re-run / resumed after interruption. Run off-peak;
**batch commits (e.g. 2–5 k cells/tx)** to keep the single-writer lock windows short and bound
WAL growth; checkpoint the WAL periodically. Validate: `COUNT(*)` ≈ 24 M, and spot-check a
sample of cards for cell-vs-JSON equality. **Rollback:** `DELETE FROM card_price_history_cell`
(JSON untouched).

### Phase 4 — Read cutover behind a flag (reversible)
Add a runtime flag (e.g. `PRICE_HISTORY_SOURCE = cells | json`, default `json`). Re-point each
reader (see Appendix B) at a cell-based query when the flag is `cells`:
- portfolio history (`_portfolio_history_rows_by_card_id` → read the holding's cells)
- top-movers / day-over-day diff (`server.py` ~L2883)
- volume classifier (~L2591)
- card-detail PDP current-breakdown + per-card history
- day-change (`_yesterday_*`)

**Gate the flip on the parity harness (below) showing 100 % match**, then flip on staging, watch
the `portfolio_dashboard_request` logs + spot-checks, then prod. **Rollback:** set flag to `json`.

### Phase 5 — Drop the JSON (the one irreversible step)
After parity is confirmed live for a soak period, drop `raw_contexts_json`,
`graded_contexts_json`, `source_payload_json`, `source_url` from `card_price_history_daily` and
`VACUUM` to reclaim ~11 GB. **Do this only on explicit go-ahead** — it's the point of no return.

### Phase 6 — The feature you actually want
Now that per-condition / per-grade history is a trivial indexed query, add:
- `GET /api/v1/cards/{id}/price-history?lane=raw&condition=NM` (and `?lane=graded&grader=PSA&grade=9`)
- card-detail UI: condition/grade selector on the price chart; "NM vs LP" / "PSA 9 vs PSA 10"
  comparisons; per-condition movement in insights.

---

## Parity harness (the correctness gate — blocks Phase 4 and Phase 5)

`tools/verify_price_history_parity.py`: for a large random sample of `(card_id, price_date)` and,
within each, every `(variant, condition)` and `(grader, grade)` cell, compare the price resolved
the **old way** (parse JSON → existing resolvers `_resolve_raw_context_summary` /
`_resolve_graded_context_entry` / `_coerce_price_summary_from_entry`) against the **new way**
(cell-table read). Must be **byte-identical** on `low/market/mid/high/direct_low/trend/currency`.
Also re-run the existing portfolio test suites and a few real owners' full dashboards old-vs-new.
Any mismatch blocks the cutover.

---

## Risks & mitigations

- **Resolution parity (top risk).** The new cell readers must reproduce the exact fallback
  semantics (specific variant/condition → default fallback). → The parity harness gates every
  irreversible step; keep the JSON until parity is proven in prod.
- **Backfill write volume (~24 M inserts).** → Chunked + batched commits, off-peak, WAL
  checkpoints, resumable; it's INSERT-only into a fresh table so it won't block reads (WAL).
- **Single-writer contention with the daily sync.** → Dual-write is tiny per card; backfill runs
  when the sync isn't (sync is 1 pm PT). Keep transactions short.
- **Index size on 24 M rows.** → A few hundred MB total; still far under today's 15.5 GB. Validate
  with `EXPLAIN QUERY PLAN` that the dashboard/PDP queries hit the partial indexes.
- **Merge semantics.** Today's writer merges partial provider updates into the existing JSON. →
  Phase 2 must replicate this at the cell level (upsert, lane-scoped deletes only), covered by
  tests that mirror the existing merge tests.
- **Rollback.** Phases 1–4 are reversible (drop table / stop dual-write / flag back to `json`).
  Phase 5 (drop columns + VACUUM) is the only irreversible step and is explicitly gated.

---

## Rough effort

- Phase 1: ~0.5 day (schema + tests).
- Phase 2: ~1–1.5 days (cell decomposition + merge semantics + tests).
- Phase 3: ~0.5 day to write, plus backfill runtime (hours, unattended).
- Phase 4: ~1.5–2 days (cutover each reader + parity harness + flag + staging soak).
- Phase 5: ~0.5 day (drop + VACUUM, gated).
- Phase 6 (feature): ~1–2 days API + UI.

≈ **5–7 working days** end to end, mostly reversible, with the irreversible drop last and gated.
None of it is required for the 30-user launch — the dashboard cache already covers that. This is
the structural cleanup + the per-condition/per-grade-history feature.

---

## Appendix A — verified JSON cell structure (live sample, card `me3-120`)

```
raw_contexts_json:    { "variants": { "<Variant>": {
                          "variant","variantKey",
                          "conditions": { "<COND>": {
                              "currencyCode","low","market","mid","high","directLow","trend", ... } } } } }

graded_contexts_json: { "graders": { "<Grader>": {
                          "<Grade>": [ {                      // a LIST — a grade can hold several variants
                              "grader","grade","variant","variantKey",
                              "currencyCode","low","market","mid","high","directLow","trend",
                              "isPerfect","isSigned","isError", ... } ] } } }
```

## Appendix B — code touch-points (2026-06-09)

- **Writer / schema:** `catalog_tools.py`
  - upsert into `card_price_history_daily` ~L3582–3629 (add cell decomposition here)
  - schema-patch path ~L579–592, L1094 (add the new table + indexes here)
  - existing resolvers to reuse in the parity harness: `_raw_contexts_payload`,
    `_graded_contexts_payload`, `_resolve_raw_context_summary`, `_resolve_graded_context_entry`,
    `_coerce_price_summary_from_entry`, `_raw_context_entry`, `_resolve_default_raw_context`
  - other catalog reads to cut over: `catalog_tools.py` ~L3518, 3649, 3724, 3782, 3792, 3870
- **Readers:** `server.py`
  - portfolio history: `_portfolio_history_rows_by_card_id` (~L3131), `_yesterday_*` (~L3190, 3221)
  - top-movers / day-diff: ~L2883 (curr/prev JOIN)
  - volume classifier: ~L2591
  - dashboard cache version token: ~L11827 (`MAX(price_date)` — unchanged, still valid)
- **Tables that already separate "latest":** `card_price_snapshots` (40 K rows) — confirm whether
  PDP current price reads it or the latest `card_price_history_daily` row, and route PDP's
  full-breakdown read to the latest cells.

> Line numbers are a snapshot; re-grep before editing.
