# Production post-deploy TODO

`pnpm backend:deploy:production` prints this file after a successful deploy.
Do every open item, then delete it here (and delete the file once empty).

## Sealed product price history backfill (32 days)

Asked for 2026-09-23. Production only, never staging. Sealed products (booster
boxes, ETBs, tins) only; card history must stay untouched.

Why it waits for a deploy: prod has no sealed catalog yet. The sealed code
(`backend/sealed_products.py`, ingest in `sync_tcgcsv_prices.py`) and
`backfill_tcgcsv_history.py --sealed-only` arrive with the deploy.

1. **Catalog.** The TCGCSV sync ingests sealed products from its own crawl
   (`TCGCSV_SEALED_INGEST`, on by default). Run it once instead of waiting
   for the daily 6 PM PT run:
   `ssh prod: cd /home/stephenchan && ./spotlight/run_tcgcsv_sync_vm.sh`
   Check: `SELECT COUNT(*) FROM cards WHERE supertype='Sealed'` is ~4,000
   (staging had 4,055).
2. **Archives (laptop).** Extract the 32 days before the deploy day
   (today−32 … yesterday; needs `7zz`: `brew install sevenzip`):
   `python3 tools/extract_tcgcsv_archives.py --start <today-32> --end <yesterday> --out-dir <scratch>/tcgcsv-history-sealed`
   This writes `prices-<date>.json.gz` plus a fresh `products.json.gz`. Copy
   the folder to prod as `/home/stephenchan/tcgcsv-history-sealed/`.
3. **Replay (prod VM).** Needs explicit approval in the conversation and
   `SPOTLIGHT_PROD_CONFIRM=yes`. Dry run first:
   `cd ~/spotlight && .venv/bin/python backfill_tcgcsv_history.py --database-path data/spotlight_scanner.sqlite --prices-dir /home/stephenchan/tcgcsv-history-sealed --sealed-only --dry-run`
   then again without `--dry-run`. It prints `--sealed-only: N sealed products`
   and refuses (exit 1) if the catalog from step 1 is missing. Only ~3k
   products instead of ~45k cards, so expect minutes, not the 3-5 h of the card
   backfill.
4. **Verify.** A booster box's card page shows a 30-day chart, and
   `card_price_history_daily` has ~32 dated rows for a sealed id
   (`tcgp-sealed-<productId>`).
