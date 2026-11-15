# PDP price chart — production plan (2026-11-01)

Status: fixes LIVE ON STAGING (backend deploy + OTA 7a7fdf4a / 1fdbb367). Production untouched. Every step below needs explicit approval, one at a time.

## What is wrong on prod today (read 2026-11-01)

- Japanese cards return their history in JPY (e.g. `swshp_ja-323`). The app must never show yen.
- The near-mint line mixes Scrydex and TCGplayer days and comes back twice ("Holofoil" and "holofoil").
- History only starts 2026-04-16, so 1Y is mostly empty.
- Conditions (LP/MP/HP/DM) are fine on prod — Scrydex keeps them current. (Staging's are frozen at 2026-07-19; that is staging-only.)

## What changed in code (on `booth-posts`, uncommitted)

- `backend/server.py` `card_condition_history`: USD rows only (always answers `currencyCode: USD`); variant spellings merged; one point per day; a TCGCSV-priced printing's NM line is TCGCSV cells ONLY.
- App `card-price-chart-model.ts`: no chart for non-USD; a line whose newest point is older than 14 days shows "No recent prices for this condition." on every range.
- Tests: `backend/tests/test_main_raw_trend_series.py`, `backend/tests/test_price_history_cells.py`, `apps/spotlight-rn/__tests__/features/cards/card-price-chart-model-test.ts`.

## Order matters

The backend change drops the Scrydex near-mint days. Deployed alone, prod's NM chart would shrink to "since TCGCSV started on prod". So the backfill goes FIRST — it only writes history rows and is safe under the current prod code.

1. **Prod checked 2026-11-01 (read-only):** 43 GB free, DB 51.6 GB; TCGCSV `raw_main` cells start **2026-08-12**. Backfill window = **2025-11-02 → 2026-08-11** (~283 days). Re-check disk right before running.
2. **Extract on the laptop:** `tools/extract_tcgcsv_archives.py` for the window (archives returned 200 on 2026-11-01 after being 403 since 2026-09-29). Measured cost: ~1–1.5 GB of DB per 32 days → roughly 9–14 GB for ~11 months.
3. **Backfill prod:** scp the extracts, run `backfill_tcgcsv_history.py` on the prod VM with `SPOTLIGHT_PROD_CONFIRM=yes`. ~5–6 min per day of history → roughly a day of wall time; run under nohup, it is restartable per date.
4. **Deploy backend to prod** through the release gate (needs approval + `SPOTLIGHT_PROD_CONFIRM=yes`).
5. **Production OTA — scope decision needed.** The chart lives on the uncommitted `booth-posts` working tree, which also carries booth posts / stories / show feeds that are NOT on prod (Supabase migrations social_27+ not applied there). A prod OTA from this tree would ship all of it. Options: cherry-pick the chart onto a prod-bound branch, or wait until booth posts goes to prod.

## Not fixable by backfill

TCGCSV has one market price per printing (≈ near mint). LP/MP/HP/DM history before 2026-04-16 does not exist anywhere we have; it grows forward from Scrydex. Tested 2026-11-01: Scrydex `price_history?days=365` returns only 181 days (`total_count`), less than the ~200 days we already store, so Scrydex cannot fill it.
