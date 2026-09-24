# Sealed products: search first (2026-09-23)

**Ask:** let people search sealed product (booster boxes, ETBs, bundles, tins, collections, packs) and see its price. Adding sealed to a collection/watchlist, barcode scanning, and box-photo scanning are **parked** until decided.

## Have vs need

**Have**
- TCGCSV `/products` for every game we price (Pokémon EN 3, JP 85, One Piece 68, Lorcana 71, Gundam 86, Riftbound 89) is already fetched daily by `backend/sync_tcgcsv_prices.py`. Sealed rows are the ones with no card `Number`; we read them and throw them away.
- The daily price sync finds a card's TCGplayer product through its `source_payload_json.variants[].marketplaces[tcgplayer].product_id` (or the derived `card_tcgplayer_products` index). Any `cards` row shaped that way gets a TCGplayer market price, snapshot, daily history and cells for free.
- Card search gates rows by game at the one point they materialize (`catalog_tools._search_cards_attempt`), so a second gate there keeps sealed out of card results.

**Need**
1. **Ingest** (`tools/sync_tcgcsv_sealed.py` + `catalog_tools`): upsert each sealed product as a `cards` row — id `tcgp-sealed-<productId>`, `supertype='Sealed'`, `subtypes=[<product type>]` (parsed from the name: Elite Trainer Box, Booster Box, Booster Bundle, Booster Pack, Tin, Collection, Blister, Case, Display, Build & Battle, Other), `number=''`, `rarity=''`, `variant='Sealed'`, `set_name` = TCGCSV group name, `set_id` NULL (so set browse never shows sealed), `game`/`language` from the category, TCGplayer image, and a payload carrying the product id. No Scrydex credits. Runs before the price sync.
2. **Keep sealed out of card features**: card search + scanner text fallback (gate), card scanner image index (`tools/build_raw_visual_index.py`, `backend/visual_index_incremental.py`), Top Trends (`backend/market_movers.py`), EN↔JP link builder (`tools/build_card_language_links.py`).
3. **Sealed search**: `GET /api/v1/cards/search?kind=sealed` — simple name/set token match over the ~7k sealed rows, all games; old clients never send `kind` and get cards only.
4. **App**: a **Sealed** chip in the catalog search chip row (mutually exclusive with rarity chips) → sealed results in the same grid; the card page renders a sealed product (no number / condition / grade / PSA / printing chips).

## Invariant note
AGENTS.md keeps raw *card* identity/pricing on the Scrydex-first lane. Sealed products are not cards and Scrydex has no sealed history, so sealed identity + price come from TCGCSV (TCGplayer), the same source that already sets the raw main price.

## Parked
- Add sealed to collection / watchlist (`item_kind='sealed'`, sealed add sheet).
- Barcode scan (ML Kit module + UPC-A/ITF-14, native build; TCGCSV UPC coverage 27% EN, many shared → candidates + confirm, crowd-sourced map).
- Box-photo scan (separate SigLIP2 sealed index; gate on ~20–30 real photos top-5 test first).
