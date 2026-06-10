# Database Size-Reduction Plan (Option D)

Status: PLAN ONLY — not started. Owner decision pending.
Created: 2026-06-10
Related: [price-history cell migration](./price-history-cell-migration-*.md), `backend/server.py`,
`backend/catalog_tools.py`, memory `project_price_history_cell_migration`.

---

## Plain-English problem

The app feels slow (and times out right after a reboot) for one reason: **the database is
~25 GB but the server only has 8 GB of RAM, and it sits on a slow disk.** Whenever the data the
app needs isn't already in memory, it has to crawl it off that slow disk.

Here's the thing though: **the app barely uses most of that 25 GB.** The data the collection page
actually reads on every refresh — your inventory, card names/images, and recent prices — is *tiny*
(a few hundred MB at most). The other ~24 GB is deep **price history**: per-condition and per-grade
price points for every card we track, going back as far as we have data, plus some redundant JSON
copies of that same history.

So the box is being forced to drag around 24 GB of cold archive data that the hot path almost never
touches. **Option D = separate the cold archive from the hot path so the database the app reads is
small enough to live entirely in memory.** Once that's true, the slow disk basically stops mattering
for day-to-day use, and we could even *stay on the cheap box safely* — including under load.

## What's actually taking the space (measured)

> Numbers from `dbstat` on the staging VM, 2026-06-10. _(Fill in once the dbstat query completes;
> placeholders below reflect known composition.)_

| Object | Rows | Approx size | Hot path uses it? |
|---|---|---|---|
| `card_price_history_cell` | ~24.7 M | ~XX GB | Only the latest day per card (tiny slice) |
| `card_price_history_daily` (incl. JSON cols) | ~2.26 M | ~XX GB | Latest snapshot + per-owner card rows |
| `card_price_history_daily` JSON columns alone (`raw_contexts_json`, `graded_contexts_json`, `source_payload_json`) | — | ~XX GB | **No — redundant now that cells are source of truth** |
| `cards` | ~XXX K | ~XX MB | Yes (metadata, images) — keep hot |
| `deck_entries` / `sale_events` / `scan_events` | small | ~XX MB | Yes — keep hot |

Key insight to confirm with the numbers: **the JSON columns on `card_price_history_daily` are now
dead weight.** Since the cell migration (`PRICE_HISTORY_SOURCE=cells`), the per-condition/per-grade
cells are the source of truth; the fat JSON contexts are a legacy duplicate the read path no longer
needs. That's the cheapest, safest win and should go first.

## The strategy, in three escalating tiers

Each tier is independently shippable and reversible. Do them in order; stop when the box feels good.

### Tier 1 — Drop the redundant JSON columns (cheapest, biggest-bang-per-risk)

The abandoned "Phase 5" was exactly this, and it caused outages **because of HOW it was done**
(dropping columns on the live multi-million-row table on the slow disk ballooned the WAL, loaded the
box, and deadlocked SSH). The goal is right; the method was wrong. Redo it with the safe recipe we
proved out for the cell migration:

1. Confirm via the parity harness that no read path depends on the JSON columns when
   `PRICE_HISTORY_SOURCE=cells` (the cell readers already cover raw + graded; verify
   `reconstruct_*_from_cells` covers every consumer).
2. Build a **slim copy table** (`card_price_history_daily_slim`) WITHOUT the JSON columns, in the
   background, on a staging table — never `ALTER TABLE ... DROP COLUMN` in place.
3. Copy rows in **rowid-ordered batches** (append-friendly; avoids WITHOUT-ROWID page splits).
4. Build the slim table's secondary indexes **outside the systemd start window** (we learned: never
   let startup rebuild big indexes — it crash-loops past the 90s timeout).
5. Atomic `ALTER TABLE RENAME` swap inside one `BEGIN IMMEDIATE`. Keep the old table as
   `__old_json` until verified.
6. **Critically:** update BOTH definitions of `required_history_columns` in `catalog_tools.py` AND
   `schema.sql` to drop the JSON columns *before* restart — otherwise the startup rebuild-guard sees
   "missing" columns and drops the freshly-slimmed table (this is the exact bug that caused the
   Phase 5 crash loop).
7. `VACUUM` to reclaim freed pages — in a maintenance window, never under load (VACUUM rewrites the
   whole file and is brutal on the slow disk).

Expected reclaim: the full size of the three JSON columns across 2.26 M rows. Confirm with dbstat.

### Tier 2 — Split history into a separate attached database (the structural win)

Move the two big history tables into their own file and `ATTACH` it, so the **main** DB shrinks to
just the hot path.

- New file `spotlight_history.sqlite` holds `card_price_history_cell` + `card_price_history_daily`.
- Main `spotlight_scanner.sqlite` keeps `cards`, `deck_entries`, `sale_events`, `scan_events`, etc.
  — small enough to sit fully in page cache.
- Backend opens both: `ATTACH DATABASE '.../spotlight_history.sqlite' AS history;` per connection,
  and price queries reference `history.card_price_history_cell`.
- litestream config gains a second DB to replicate; both still WAL-mode.

Why this is the big lever: once the hot DB is ~1 GB, it stays 100% cached even at 8 GB RAM, so the
collection page is fast cold-or-warm, reboot-or-not, 3 users or 30. The slow disk only matters for
price-history reads, which are already cache-keyed (the dashboard cache) and prewarmed.

Cost: moderate code change (every price query needs the `history.` schema prefix or a search-path
shim) + a one-time data move (background copy + swap, same safe recipe). Fully reversible (the
attach is config; the data move keeps the old combined file until verified).

### Tier 3 — Retention / archival policy (keeps it small forever)

History grows ~daily. Without a policy, we re-inflate. Add a retention job:

- Keep full-resolution daily/cell history for a recent window (e.g. 18–24 months).
- **Downsample** older history (weekly or monthly points) rather than deleting — preserves the
  long-range charts at a fraction of the rows.
- Archive raw older rows to GCS (Parquet/CSV) before downsampling, so nothing is truly lost.
- Run as a scheduled maintenance task (off-peak), not at startup.

This caps both the history file size and the cost of future rebuilds/VACUUMs.

## Sequencing & guardrails

1. **Measure first** (dbstat per-object sizes) so we attack the biggest object, not the assumed one.
2. **Tier 1** in a maintenance window → re-measure → confirm reclaim.
3. **Tier 2** only if the hot DB still doesn't fit / cold reads still bite after Tier 1.
4. **Tier 3** after the structure is settled, to keep it that way.

Hard-won guardrails (from the Phase 5 / husk-drop incidents — see memory):
- Never `DROP TABLE` / `VACUUM` / build big indexes on a live multi-million-row table on the slow
  disk during request hours — it deadlocks SSH-over-IAP and can crash-loop the service.
- Always: staging-table → background copy → build indexes off the startup path → atomic RENAME swap
  → keep `__old` until verified.
- Keep `schema.sql` and BOTH `required_history_columns` definitions in lockstep with any column
  change, or the startup rebuild-guard will drop the table out from under you.
- litestream owns WAL checkpointing; coordinate big writes so the WAL doesn't balloon.

## What we are NOT doing

- Not changing `confirmed_card_id` / training-label invariants.
- Not touching the Scrydex-first identity/pricing lanes.
- Not making scan artifacts public.
- Not rebuilding catalogs at startup or seeding local JSON runtime sources.

## Payoff summary

- **Tier 1**: reclaim the redundant JSON (low risk, done-right this time).
- **Tier 2**: hot DB fits in RAM → fast regardless of reboots/load → the cheap box becomes genuinely
  safe, even for the 30-user week.
- **Tier 3**: stays small and cheap to maintain.

The companion quick fix already shipped: **startup dashboard prewarm** (`prewarm_portfolio_dashboards`
in `server.py`) warms each owner's dashboard at boot so the post-reboot cold-timeout (the symptom
that triggered this plan) can't recur. D is the durable, cost-lowering follow-through.
