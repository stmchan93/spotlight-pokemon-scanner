# One Piece real-card query fixtures

Real photographs of real One Piece TCG cards, labelled with the catalog card id, for
evaluating the One Piece visual index.

## Why this set exists

The One Piece visual index is built from Scrydex's Bandai artwork, and that artwork carries a
semi-transparent white **SAMPLE** watermark across the middle third of the card. Real cards do
not have it. Any evaluation that degrades the reference image synthetically shares the watermark
with the index and therefore *cannot see this class of bug*: it will report a high top-1 rate on
an index that fails to identify a real card. These fixtures are the counterweight — every image
here is a photograph of a physical card, taken by a third party, with no SAMPLE overlay.

`onepiece~OP05-119` (`monkey-d-luffy-op05-119`) is the named regression from that investigation
and is included deliberately.

## Layout

This directory is a `--fixture-root` for `tools/eval_raw_visual_model.py`. Each fixture is one
directory:

```
<fixture-name>/
  runtime_normalized.jpg        # 630x880 deskewed card crop - the query image the eval embeds
  source_scan.{jpg,png,webp}    # the untouched third-party photo the crop came from
  truth.json                    # cardName / collectorNumber / setCode / setName / rarity / printingLanguage
  label_status.json             # providerMapping.providerCardId = the catalog id, plus how it was verified
  runtime_selection_summary.json# OCR artifact slot (intentionally empty - see below)
  source_provenance.json        # image URL, listing page URL, listing title, domain
```

`eval_raw_visual_model.py` finds fixtures by `rglob("truth.json")`, requires
`runtime_normalized.jpg`, resolves the expected card id from `label_status.json`
(`providerMapping.providerCardId`) because these truth keys are not in the Pokemon
`provider_reference_manifest.json`, and requires an OCR artifact for the fixture to count as
"supported".

**The OCR artifact is deliberately empty.** These are listing photos, not scans captured through
our runtime, so there is no genuine OCR pass to record. `runtime_selection_summary.json` carries
null/zero fields so the fixture is counted and ranked **visually only**. Do not backfill the true
collector number into it: that would leak the label into the hybrid reranker and inflate
`hybridTop1PassRate`. Read `visualTop1PassRate` / `visualTop10ContainsTruthRate` from the
scorecard for this root.

## How each label was confirmed

Every fixture passed all four checks, by eye, at full resolution:

1. **Number** - the printed collector number in the bottom-right nameplate was read off the
   photograph and matched the fixture's `collectorNumber` (see "verification" in
   `label_status.json`).
2. **Name plate** - the character name and type line match the catalog row in
   `backend/data/spotlight_multigame_test.sqlite` (`SELECT id, name, set_name FROM cards WHERE id = ?`).
   All 42 ids exist in the catalog *and* in
   `backend/data/visual-index/visual_index_active_onepiece_manifest.json`.
3. **Artwork** - the artwork was compared against the cached index reference image
   (`backend/data/visual-index/.cache/reference_images_onepiece/onepiece~<NUM>.png`). This matters
   more in One Piece than in Pokemon: **many One Piece printings share one collector number**
   (OP05-119 alone has a base SEC art plus manga, WANTED, comic and anniversary parallels), while
   the catalog and the index hold exactly **one artwork per number**. A photo of a parallel would
   be correctly labelled by id and still be visually unmatchable, which would read as a permanent
   model failure. Every fixture here shows the *same artwork as the index reference*.
4. **No watermark** - the middle band was screened numerically (fraction of near-white pixels;
   watermarked Bandai art runs ~0.22, clean photos ~0.02) and then confirmed visually. The metric
   alone is not trustworthy - it misses SAMPLE over bright artwork and false-positives on
   white-heavy art - so the numeric screen only ordered candidates and the decision was always
   made by eye.

## Composition

- 42 fixtures.
- Rarity: 14 Secret Rare, 8 Super Rare, 8 Common, 5 Leader, 5 Rare, 2 Uncommon.
- Sets: OP01 (5), OP03 (4), OP06 (3), OP07 (3), OP09 (3), EB02 (2), OP04 (2), OP05 (2), OP10 (2),
  OP11 (2), OP14 (1), OP15 (2), OP16 (2), ST12 (2), ST13 (2), EB01 (1), OP02 (1), OP12 (1),
  ST01 (1), ST14 (1).
- Printing language: 35 English, 7 Japanese. Japanese printings share the artwork and collector
  number with the English card and are labelled with the same (English) catalog id, because the
  catalog carries no Japanese One Piece rows. They are tagged `"printingLanguage": "Japanese"` in
  `truth.json` so results can be partitioned; a language-sensitive failure should not be read as a
  watermark failure.
- Near-duplicate families are deliberately represented: 5 Monkey.D.Luffy printings
  (OP05-119, OP09-119, OP10-118, OP11-118, EB02-061), 3 Sanji (OP07-064, OP09-065, ST12-011),
  2 Portgas.D.Ace (OP07-119, ST13-010), 2 Boa Hancock (OP01-078, OP16-112), 2 Roronoa Zoro
  (OP01-025, OP06-118).
- Capture conditions are real: holo/foil glare, off-axis angles, dark desk backgrounds, one card
  still in a penny sleeve (OP01-078), one still in a PSA slab (OP05-119, cropped to the card
  window). `truth.json.captureKind` records which.

## Provenance and usage

**These are third-party marketplace listing photographs, held for internal evaluation only.**
They are not ours, they are not licensed for redistribution, and they must not be published,
shipped in an app bundle, used as catalog imagery, or uploaded anywhere public. Each fixture's
`source_provenance.json` records the exact image URL, listing page and listing title.

Images were located through Yandex image search and through eBay search (reached via the
`shopozz.ru` eBay mirror, since eBay itself blocks direct requests from this environment); the
image files themselves are eBay's own listing images (`i.ebayimg.com`) except where the table
below shows another host.

## Sources that serve watermarked art (do not use)

Every one of these looked like a plausible source of clean card imagery and turned out to serve
the SAMPLE-watermarked Bandai art, verified by eye:

- `asia-en.onepiece-cardgame.com` - Bandai's own official English card gallery is watermarked.
- `limitlesstcg` (`limitlesstcg.nyc3.cdn.digitaloceanspaces.com`) - all printings, all parallels.
- `storage.googleapis.com/images.pricecharting.com` - PriceCharting card images.
- `unicorncards.co.uk` and similar single-card webshops - watermarked art with the shop's own
  watermark added on top.
- `onepiece.cardsrealm.com`, `cardotaku.com`, `dotgg.gg`, `chaoscards.co.uk` - database/shop art.
- Bulk eBay singles listings frequently reuse the Bandai art as the listing image, sometimes
  captioned "this is a stock photo". Roughly half of all harvested eBay images were watermarked
  stock art rather than a photo of the card being sold.

Counterfeit risk was screened too: "proxy"/"custom"/"orica" listings and Russian/Chinese
marketplace listings (AliExpress, Ozon, Wildberries, Yandex.Market) were excluded, because their
cards are frequently proxies with non-official frames and rewritten card text.

## Known gaps

- Chase Secret Rares are over-represented relative to Commons/Uncommons, because sellers
  photograph expensive cards individually while cheap singles are usually listed with Bandai
  stock art.
- Cards whose index reference art is a parallel (for example OP02-120 Uta, OP09-061
  Monkey.D.Luffy, OP01-121 Yamato, OP01-024 Monkey.D.Luffy) were dropped: no photograph of that
  exact printing could be sourced with confidence, and a base-art photo would have been a
  mislabelled fixture.
- Leaders from starter decks are thin (5 total) for the same reason.

## Fixture index

| fixture | card id | rarity | printing | source image | listing |
| --- | --- | --- | --- | --- | --- |
| `blue-gilly-op10-054` | `onepiece~OP10-054` | Common | English | https://i.ebayimg.com/images/g/Pr4AAeSwRw5pQKC0/s-l1600.jpg | https://shopozz.ru/items/227133426344-one-piece-tcg---blue-gilly---op10-054---royal-blood---english |
| `boa-hancock-op01-078` | `onepiece~OP01-078` | Super Rare | English | https://i.ebayimg.com/images/g/Ax8AAOSwf3tl6H2H/s-l500.jpg | https://www.ebay.com.hk/itm/186331232837 |
| `boa-hancock-op16-112` | `onepiece~OP16-112` | Common | English | https://i.ebayimg.com/images/g/8wAAAeSw0gxqYX3T/s-l1600.jpg | https://shopozz.ru/items/287478916909-bandai-one-piece-card-game-boa-hancock-character-op16-112-special-6c-8000-eng |
| `borsalino-op02-114` | `onepiece~OP02-114` | Super Rare | English | https://cdn.chaoscards.co.uk/uploads/prod_img/2_215257_e.png?v=1678897138 | https://www.chaoscards.co.uk/prod/one-piece-card-game-single-cards/borsalino-op02-114-paramount-war-one-piece-single-card |
| `charlotte-katakuri-op03-123` | `onepiece~OP03-123` | Secret Rare | Japanese | https://i.ebayimg.com/images/g/hToAAOSwMsxj5xWW/s-l400.jpg | https://www.ebay.com.au/itm/234893612944 |
| `daruma-op06-029` | `onepiece~OP06-029` | Uncommon | English | https://i.ebayimg.com/images/g/qOsAAeSw7nhpbqFQ/s-l1600.jpg | https://shopozz.ru/items/377141564754-one-piece---op06-029---daruma---uc---us-seller |
| `donquixote-doflamingo-op01-060` | `onepiece~OP01-060` | Leader | English | https://i.ebayimg.com/images/g/SGsAAOSwi2dl0Mom/s-l400.jpg | https://shopozz.ru/items/365294829735-donquixote-doflamingo-060-op01-060-romance-dawn-regular |
| `donquixote-rosinante-op04-119` | `onepiece~OP04-119` | Secret Rare | English | https://cdn.chaoscards.co.uk/uploads/prod_img/2_230453_e.png?v=1696000725 | https://www.chaoscards.co.uk/prod/one-piece-card-game-single-cards/donquixote-rosinante-alternate-art-op04-119-kingdoms-of-intrigue-one-piece-single-card |
| `dr-hogback-op06-090` | `onepiece~OP06-090` | Rare | English | https://i.ebayimg.com/images/g/BWQAAeSwhZ9qWP8k/s-l1600.jpg | https://shopozz.ru/items/407095819085-one-piece-wings-of-the-captain-dr-hogback-rare-foil-op06-090 |
| `dracule-mihawk-op01-070` | `onepiece~OP01-070` | Super Rare | Japanese | https://i.ebayimg.com/images/g/9wIAAOSwTYBi5SP9/s-l500.jpg | https://www.ebay.ca/itm/234641227763 |
| `enel-op15-118` | `onepiece~OP15-118` | Secret Rare | English | https://i.ebayimg.com/images/g/PyMAAeSwVf1qekTf/s-l1600.jpg | https://shopozz.ru/items/236998248206-one-piece-enel-op15-118-secret-rare-sec-foil-card-adventure-on-kamis-island |
| `gol-d-roger-op09-118` | `onepiece~OP09-118` | Secret Rare | English | https://i.ebayimg.com/images/g/VW4AAeSwcOdpwGvP/s-l1600.jpg | https://shopozz.ru/items/406792084707-gol-d-roger-op09-118-sec-secret-rare-emperors-of-the-new-world-nm-english |
| `hannyabal-eb01-021` | `onepiece~EB01-021` | Leader | English | https://i.ebayimg.com/images/g/LW0AAeSwKEtqJIdj/s-l1600.jpg | https://shopozz.ru/items/198407114914-hannyabal-eb01-021-leader-extra-booster-memorial-collection-one-piece-near-mint |
| `jewelry-bonney-op12-118` | `onepiece~OP12-118` | Secret Rare | Japanese | https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/dr000/auc0205/user/be4e9957b4f1bd572a9d8bf560d50ff5701b85f13a6370f6aceb2179465489d6/i-img1200x1200-17791592927394fexto94140.jpg | https://auctions.yahoo.co.jp/jp/auction/v1230424577 |
| `jinbe-op16-027` | `onepiece~OP16-027` | Rare | English | https://i.ebayimg.com/images/g/BtgAAeSw-h9qf1aE/s-l1600.jpg | https://shopozz.ru/items/377418615748-jinbe-027-op16-027-rare-the-time-of-battle-one-piece-foil-near-mint |
| `johnny-op14-028` | `onepiece~OP14-028` | Common | Japanese | https://i.ebayimg.com/images/g/rH0AAeSwkGZpwCXl/s-l1600.jpg | https://shopozz.ru/items/117101942047-japanese-one-piece-tcg-johnny-the-azure-seas-seven-op14-028-common |
| `kaido-op05-118` | `onepiece~OP05-118` | Secret Rare | Japanese | https://i.ebayimg.com/images/g/fWIAAOSwqFtk62QY/s-l400.jpg | https://www.ebay.ie/itm/314797219078 |
| `koby-op11-001` | `onepiece~OP11-001` | Leader | English | https://i.ebayimg.com/images/g/3NoAAeSwiodqfnFE/s-l1600.jpg | https://shopozz.ru/items/257679112826-koby-001-op11-001-leader-a-fist-of-divine-speed-one-piece-moeka-araki-nm |
| `kuroobi-op03-026` | `onepiece~OP03-026` | Uncommon | English | https://i.ebayimg.com/images/g/xGcAAeSwAY9qYjEQ/s-l1600.jpg | https://shopozz.ru/items/377364752117-kuroobi-op03-026-uc-pillars-of-strength-one-piece-nm |
| `marco-op03-013` | `onepiece~OP03-013` | Super Rare | Japanese | https://i.ebayimg.com/images/g/VLYAAOSwChVkg0zH/s-l400.jpg | https://www.ebay.ie/itm/314386819975 |
| `monkey-d-garp-eb02-049` | `onepiece~EB02-049` | Rare | English | https://i.ebayimg.com/images/g/BA0AAeSwAzdowKMm/s-l1600.jpg | https://shopozz.ru/items/365854707737-monkeydgarp-eb02-049-extra-booster-anime-25th-collection---english-nm-r-foil |
| `monkey-d-luffy-eb02-061` | `onepiece~EB02-061` | Secret Rare | English | https://i.ebayimg.com/images/g/U2IAAeSwPpdqb6U7/s-l1600.jpg | https://shopozz.ru/items/800450457704-monkeydluffy-061-sec-extra-booster-anime-25th-collection-eb02-061-2 |
| `monkey-d-luffy-op05-119` | `onepiece~OP05-119` | Secret Rare | English | https://i.ebayimg.com/images/g/R4YAAOSwYhRnW1pU/s-l1600.jpg | https://shopozz.ru/items/196891288821--psa-10-monkey-d-luffy-2023-one-piece-op05-119-awakening-of-the-new-era-english |
| `monkey-d-luffy-op09-119` | `onepiece~OP09-119` | Secret Rare | English | https://i.ebayimg.com/images/g/o4AAAeSw4vtqfNBu/s-l1600.jpg | https://shopozz.ru/items/188783059531-monkeydluffy---op09-119-alt-art-sec-holo-one-piece-tcg-nm |
| `monkey-d-luffy-op10-118` | `onepiece~OP10-118` | Secret Rare | English | https://i.ebayimg.com/images/g/we8AAeSw~vBqG7CZ/s-l1600.jpg | https://shopozz.ru/items/318387425010-one-piece-royal-blood-monkey-d-luffy-op10-118-secret-rare-card-english-edition |
| `monkey-d-luffy-op11-118` | `onepiece~OP11-118` | Secret Rare | English | https://i.ebayimg.com/images/g/a98AAeSw~LpqbVhk/s-l1600.jpg | https://shopozz.ru/items/257674836870-monkeydluffy-118-op11-118-a-fist-of-divine-speed-sec-one-piece-tcg-card-nm |
| `monkey-d-luffy-st01-012` | `onepiece~ST01-012` | Super Rare | English | https://i.ebayimg.com/images/g/CXQAAeSwYttqb5tx/s-l1600.jpg | https://shopozz.ru/items/800508567478-monkeydluffy-st01-012-sr-foil-one-piece-starter-deck-1-straw-hat-crew |
| `nico-robin-st14-007` | `onepiece~ST14-007` | Common | English | https://i.ebayimg.com/images/g/IIsAAeSwvaVqRrYk/s-l1600.jpg | https://shopozz.ru/items/398262201520-nico-robin---pirate-foil-st14-007-c-premium-booster--the-best--vol-2-nm |
| `oars-op15-080` | `onepiece~OP15-080` | Rare | English | https://i.ebayimg.com/images/g/ckIAAeSw8fBqb7YW/s-l1600.jpg | https://shopozz.ru/items/117337013132-oars-op15-080-adventure-on-kamis-island-one-piece-ccg-r-foil-nm |
| `pappag-op07-030` | `onepiece~OP07-030` | Common | English | https://i.ebayimg.com/images/g/2wYAAeSwTONqKHpz/s-l1600.jpg | https://shopozz.ru/items/157985156980-one-piece-pappag-2024-pillars-of-strength-bandai-op07-030-c |
| `portgas-d-ace-op07-119` | `onepiece~OP07-119` | Secret Rare | English | https://i.ebayimg.com/images/g/KPoAAeSwoshqR1oY/s-l1600.jpg | https://shopozz.ru/items/358877258330-portgasdace-119-op07-119-500-years-in-the-future-one-piece-foil-nm |
| `portgas-d-ace-st13-010` | `onepiece~ST13-010` | Common | English | https://i.ebayimg.com/images/g/QwUAAeSwmf9poV8B/s-l1600.jpg | https://shopozz.ru/items/317930115378---portgas-d-ace---st13-010-premium-booster-promo-pirate-foil-one-piece-tcg-nm |
| `roronoa-zoro--sanji-st12-001` | `onepiece~ST12-001` | Leader | English | https://i.ebayimg.com/images/g/BJMAAeSwgvZqZNBc/s-l1600.jpg | https://shopozz.ru/items/298532713414-roronoa-zoro--sanji-st12-001-starter-deck-12-one-piece-nm-english-lp |
| `roronoa-zoro-op01-025` | `onepiece~OP01-025` | Super Rare | English | https://i.ebayimg.com/images/g/v~UAAOSwQRNjihSB/s-l1200.webp | https://kiflaps.ac.ke/025-SR-Romance-Dawn-One-Piece-TCG-CCG-1412558.html |
| `roronoa-zoro-op06-118` | `onepiece~OP06-118` | Secret Rare | English | https://media.gamestop.com/i/gamestop/prod-1_front_PSA_98394167_20250123185855569 | https://www.gamestop.com/graded-trading-cards/graded-cards/products/2024-one-piece-wings-of-the-captain-118-roronoa-zoro-alternate-art-psa-10/PSA98394167M.html |
| `sabo-st13-001` | `onepiece~ST13-001` | Leader | English | https://i.ebayimg.com/images/g/IIoAAeSwoSFqTWgC/s-l1600.jpg | https://shopozz.ru/items/366528604704-sabo-leader-st13-001-the-three-brothers-ultra-deck-english |
| `sanji-op07-064` | `onepiece~OP07-064` | Super Rare | English | https://i.ebayimg.com/images/g/NSkAAeSw1uFqaNBz/s-l1600.jpg | https://shopozz.ru/items/178351705968-sanji-op07-064-sr-one-piece-500-years-into-the-future-english |
| `sanji-op09-065` | `onepiece~OP09-065` | Super Rare | English | https://i.ebayimg.com/images/g/rEEAAeSwi2Fpyo~r/s-l1600.jpg | https://shopozz.ru/items/117116564166-sanji---op09-065-reprint-op09-065-one-piece-premium-booster-vol-2-nm |
| `sanji-st12-011` | `onepiece~ST12-011` | Common | English | https://i.ebayimg.com/images/g/Z1gAAeSwwnlqY8Bp/s-l1600.jpg | https://shopozz.ru/items/287482112036-sanji-st12-011-common-starter-deck-12-zoro-and-sanji-one-piece-near-mint |
| `senor-pink-op04-026` | `onepiece~OP04-026` | Rare | English | https://i.ebayimg.com/images/g/6hIAAOSwP-1l7eWL/s-l1600.jpg | https://shopozz.ru/items/375303363901-2023-one-piece-english-kingdoms-of-intrigue-senor-pink-op04-026-r-rare |
| `shanks-op01-120` | `onepiece~OP01-120` | Secret Rare | English | https://i.ebayimg.com/images/g/Y5YAAeSwL8lqfA4M/s-l1600.jpg | https://shopozz.ru/items/318716974063-shanks-op01-120-sec-prb-01-premium-booster-english-one-piece-foil |
| `usopp-s-pirate-crew-op03-042` | `onepiece~OP03-042` | Common | Japanese | https://i.ebayimg.com/images/g/i8gAAeSwcQBqcg4y/s-l1600.jpg | https://shopozz.ru/items/278246949441-japanese-usopps-pirate-crew-pillars-of-strength-op03-042-nm-a26517-free-sh |