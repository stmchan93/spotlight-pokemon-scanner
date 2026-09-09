# Meta Radar — research + recommendation (2026-09-09)

**Ask:** show what cards / sets / archetypes are "in" and "out" right now, across all five games (Pokémon EN+JP, One Piece, Lorcana, Gundam, Riftbound), so a collector knows what to buy, sell, trade. Where can the data come from (Reddit, RSS, tournaments, prices, eBay), what do we already hold, how does PokemonPriceTracker get sales velocity, and is an AI layer needed?

Sources verified live on 2026-09-09 (curl / fetch from a laptop). Status STATUS: RESEARCH — nothing built.

---

## 1. Plain-English answer

**Have.** We already own the single strongest cross-game signal: daily TCGplayer prices for ~45k cards (32 days of history on staging, prod after the backfill), plus the Top Trends ranking that turns it into gainers. We also log which cards our users view, scan, wishlist and add, every day. And the PokemonPriceTracker daily export we already download carries `salesVelocityWeekly` and `marketTrend` per card and grade — we throw those columns away today.

**Need.** Three things prices can't tell you: (1) *tournament usage* — what competitive players are actually running; (2) *attention* — what people are talking about and watching; (3) *calendar* — what is releasing, rotating out, or banned. All three exist in free, sanctioned, machine-readable form for most games. The exceptions are exactly where you'd expect: Reddit (policy-hostile now), eBay sold history (no legitimate API exists), and Lorcana/Riftbound tournament data (thin or bot-walled).

**Recommendation.** Build it in three layers, in this order, and treat an AI summary as the optional last layer, not the foundation:
1. **Numbers we own** — losers, set-level roll-ups, "trending among our users", new-set / rotating-out flags, PPT velocity columns. Days of work, zero new vendors.
2. **Sanctioned external feeds** — Limitless tournament API (all five games), Limitless meta pages, YouTube RSS/Data API, PokéBeach + DotGG news feeds, Scrydex pop snapshots. A nightly job, ~500 requests/day.
3. **Narrative** — one Claude call per game per day over the pre-scored top movers and top news, producing an In/Out list with one-line reasons and evidence ids. Cheap (~$1/day), but only worth it once layers 1–2 produce something to explain.

Skip: scraping Reddit, scraping eBay sold pages, PriceCharting-derived displays, anything behind Cloudflare.

---

## 2. Your questions, answered

**"Find a way to show what's in and out — Reddit, RSS, any way."** See §3 for the per-game source set. Reddit specifically: the `.json` endpoints were shut down on 2026-05-28 and return 403 to everything; `.rss` still works but is throttled to about one request per minute per IP and Reddit has said it is "under review"; the free OAuth tier is now non-commercial only with manual approval; commercial use needs a written contract. The community mirror Arctic Shift works today but is scraped Reddit content and Reddit's policy forbids commercialising it by any route. Verdict: Reddit is not a foundation. If you want it at all, use it as an internal scoring input with an off switch and file the enterprise request in parallel.

**"Do I have to do AI insights?"** Not for the signal. Ranking, velocity and flags are arithmetic and should stay deterministic. Claude earns its place only for the last step — turning "Charizard ex +38% / 22% of top-8 lists / 3 new videos this week / reprint announced" into a sentence a collector reads. The hard part there is entity resolution (mapping a Reddit title or video title to one of 50k card ids), not summarisation. Require an `evidence_ids[]` list per item so every claim is auditable.

**"Recent sales / lowest listed on eBay — can that help?"** Yes, and it's the best demand signal we can compute ourselves, with a coverage limit. Lowest listed and active listing count come from eBay's Browse API (we already call it; free; ~5,000 calls/day). Sold velocity = count of sold rows per 7 / 30 days from the Scrydex listings feed we already use for Recent Sales (24-hour cache, costs credits). Demand gap = last sold price vs lowest current ask. Coverage: we fetch these per card when someone opens it, not catalog-wide, so the signal exists only for a watch set — top movers, wishlisted, recently viewed, current meta — realistically ~1–2k cards nightly, not 50k. That is enough for a radar.

**"How does PPT get velocity and listing counts? Can I build it?"** Their documented velocity fields (`salesCount` lifetime, `salesVelocityWeekly`, `dailyVolume7Day`, `marketPrice7Day`, `marketTrend`) are per card per grade from eBay sold data. eBay's only official sold-history API (Marketplace Insights) is closed to new users, the Finding API was decommissioned in Feb 2025, and eBay's sold-listing search has been login-walled since Aug 2026 — so at catalog scale that data is scraped, or bought from someone who scrapes. Your suspicion is right. Active listing and seller counts can come from the Browse API legitimately. TCGplayer listing counts come from TCGplayer's product pages (TCGplayer closed its API), i.e. scraping too. **Can we build it:** yes for the legitimate half (Browse API listings + Scrydex sold rows, over a watch set, stored daily in our own tables — same math as PPT), no for catalog-wide sold velocity without scraping eBay, which is a hard no under the no-hacks rule. Note PPT is Pokémon-only and its JP data is TCGplayer-keyed, so it inherits TCGplayer's JP gaps. Their Terms say commercial use needs Business ($99/mo) even though the pricing page says "commercial use included" on lower tiers — resolve before depending on it. We already pay for Business-tier exports (the daily eBay CSV), so the cheapest velocity win is persisting two columns we already receive.

---

## 3. Sources, per game (verified 2026-09-09)

### Tournament usage (the "meta")

| Game | Source | Format / limits | Notes |
|---|---|---|---|
| All five | **Limitless Play API** `https://play.limitlesstcg.com/api` (`/tournaments?game=PTCG|OP|GUNDAM|LORCANA|RB`, `/tournaments/{id}/standings` with full decklists + archetype) | JSON, no key, `50-in-5min` per IP; webhooks for finished events; free key for archetype rules (public-facing projects) | Online/LGS platform. Heavy for Pokémon, decent OP, thin Gundam, near-empty Lorcana/Riftbound. Card inclusion share = derive from decklists daily. |
| Pokémon EN + JP | `https://limitlesstcg.com/decks?format=standard|standard-jp&time=1months`, `/decks/{id}/cards` (% of lists, avg copies), `/tournaments/jp` | server HTML, robots allow-all, no scraping policy | The official-event meta. Daily snapshot, identifying UA. |
| One Piece EN | `https://onepiece.limitlesstcg.com/decks`, `/decks/{id}/cards` | HTML | No JP region. |
| One Piece JP | `https://opdeckguide.com/tournaments-decklists/` (leader share + decklists), `https://onepiecetopdecks.com/deck-list/...` (decklists inline as parseable strings) | HTML | Best JP-OP signal readable by curl. |
| Pokémon JP | `https://pokeka-win-decks.jp/tier-ranking` (card adoption per archetype, City League) | HTML, on hiatus until 2026-09-23 | Official JP results site (`players.pokemon-card.com`) 403s. |
| Gundam | `https://metasheep.gg/gundam` (archetype share incl. JP qualifiers) | HTML | Best Gundam meta page. |
| Riftbound | `https://www.zero.gg/riftbound/events/{id}/standings` (official RQ standings, legend per player) | server HTML | **Riot policy forbids apps from publishing win/play rates** — phrase as news/price, not rates. Riftools / riftDecks are bot-walled. |
| Lorcana | inkDecks (`/cards/stats`, play + win rates daily) | Cloudflare 403 | Best Lorcana card stats; ask them for access rather than headless-scrape. |
| Multi | TopDeck.gg API (`https://topdeck.gg/docs/tournaments-v2`) | JSON, free key, 100/min, attribution required | Per-game volume unverified; probe with a key. |

### Attention (social / video / news)

| Source | Format / limits | Verdict |
|---|---|---|
| **YouTube channel RSS** `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` (15 latest, view counts) + Data API v3 (`playlistItems.list`, `videos.list`, 1 unit each, 10k/day; `search.list` has its own 100/day bucket) | free, no key for RSS | Cleanest sanctioned social signal. ~40 channel ids across the five games are in the research transcript (PokeRev, ThePokeCapital, Tricky Gym, Wossy Plays, Lorcana Academy, official Gundam/Riftbound, …). |
| **PokéBeach** `https://www.pokebeach.com/forums/forum/front-page-news.18/index.rss` | RSS, browser UA required; `/feed` is 403 | Set reveals, JP leaks. Fragile — alert on 403. |
| **DotGG feeds** `https://onepiece.gg/category/news/feed/`, `lorcana.gg`, `riftbound.gg`, `gundamcard.gg` | RSS | onepiece.gg / gundamcard.gg mirror Bandai's official news (Bandai's own site forbids bots). |
| Riftbound official `https://playriftbound.com/_next/data/<buildId>/en-us/news.json` | JSON, buildId rotates | Roadmap, bans. |
| Bulbapedia MediaWiki API (page revisions for `2026-27_Standard_format_(TCG)`, expansion list) | JSON, honest UA | Rotation + expansion changes. pokemon.com is Imperva-walled. |
| Wikipedia pageviews REST | JSON, free | Cheap attention proxy on characters/sets. |
| Reddit | `.json` dead; `.rss` ~1/min/IP; OAuth free tier non-commercial; Arctic Shift mirror unlicensed | Internal-only input with an off switch, or skip. Subs that matter: r/PokemonTCG 1.4M, r/PokeInvesting 360k, r/pkmntcg 143k, r/OnePieceTCG 195k, r/Lorcana 93k, r/GundamTCG 39k, r/RiftboundTCG 76k. No JP subreddit exists. |
| X API | pay-per-use $0.005/read | Viable at small scale (~$5 per 1k posts); not first. |
| Bluesky search / Discord / TikTok / IG / Google Trends / pytrends | 403 load-shedding / forbidden / no volume / gated / dead | Skip. |

### Price, volume, supply

| Source | Verdict |
|---|---|
| **TCGplayer via TCGCSV** (have) | Price velocity for all games. No volume. |
| **TCGplayer monthly "Top Selling" CSVs** (seller blog, Pokémon / One Piece / Lorcana) | Free, published. The only public TCGplayer *volume*. Monthly prior. |
| **PPT Business export** (have) | Pokémon-only eBay sold velocity + pop. Persist `salesVelocityWeekly`, `marketTrend`. |
| **eBay Browse API** (have) | Active listing count, lowest ask, bid count. 5k/day. Watch-set only. |
| **Scrydex listings** (have) | eBay sold rows, 24h cache, credits. Watch-set only. |
| **Scrydex population** (have, all plans) | Snapshot daily → pop deltas = "people are grading this". Don't scrape PSA. |
| PriceCharting API ($49/mo, `sales-volume` annual) | ToS: no redistribution/display without written consent. Reference only. |
| CardTrader API (free, EU listings) | Possible EU supply signal later. |
| eBay Marketplace Insights / Finding / sold-search / 130point / Terapeak | Closed / decommissioned / login-walled / no API. **No legitimate sold-history path.** |
| Cardmarket API, TCGplayer API | Closed. |

### Calendar / rotation / bans

| Game | Source |
|---|---|
| Pokémon | Scrydex expansions (have) + Bulbapedia rotation page; H/I/J legal, G rotated 2026-04; next announcement ~Jan 2027. Upcoming: 30th Celebration 2026-09-16, Delta Reign 2026-11-06, JP Mega Lucario Z 2026-11-27. |
| One Piece | `en.onepiece-cardgame.com/products/`, bans `news/restriction.html` (EN and JP lists differ). SD-01 2026-09-18, EB-05 Oct, OP-18 Nov. |
| Lorcana | `https://api.lorcast.com/v0/sets` (release/prerelease dates), disneylorcana.com news for bans. Core = Sets 9–13+; next rotation mid-2027. |
| Gundam | `https://api.gcgapi.com/v1/products` (ODbL, weekly), bans `gundam-gcg.com/en/news/01_279.html`. ST11–14 2026-09-25, GD06 2026-10-30. |
| Riftbound | `playriftbound.com` news/rules-hub JSON. Radiance 2026-10-23, Legacy 2027-01-29; first rotation early 2028. |

---

## 4. What we already hold (backend inventory)

- **Prices:** `card_price_history_daily` (one row/card/day; Scrydex lane + TCGplayer `main_raw_market_price`), `card_price_history_cell` (per grade / condition / printing per day; TCGplayer lane keeps low/mid/high/directLow). `backend/market_movers.py` ranks gainers with a same-source rule and a distinct-price noise filter; losers are one predicate away (`rank_candidates`, `pct <= 0`); set roll-up is a `GROUP BY set_id` over the same candidates (`_card_metadata` already joins `expansions`).
- **Velocity:** `_card_volume_level()` (distinct prices / 30d, on the PDP). PPT export columns `salesVelocityWeekly`, `marketTrend` parsed nowhere (`sync_ppt_catalog.py:475`); `ppt_graded_signals` is overwritten in place (no series). `slab_recent_sales` (eBay sold rows, per PDP view), `card_ebay_listings_cache` (Browse API, result_count capped at 20, per PDP view). `main_raw_printings_json` gives TCGplayer spread.
- **Population:** `card_price_snapshots.population_json` refreshed 06:30 UTC daily (prod only, Pokémon only), overwritten — no deltas yet.
- **Catalog:** `expansions.release_date` (indexed), `cards.regulation_mark` stored but no Standard-legality logic; rarity buckets per game.
- **Our users:** `card_views` (per user per day, indexed by card, already "N watching"), `scan_events` (per day, predicted/selected/confirmed ids), `card_favorites`, `card_likes`, `deck_entries`/`deck_entry_events`. "Trending among our users" = one GROUP BY, zero schema.
- **Prior art:** `docs/notifications-market-signals-plan-2026-07-15-TABLED.md` — guardrails to reuse verbatim ($5 floor, ≥12% vs window median, raw-lane fenced to EN, never "all-time", information not advice, empty ⇒ silent).
- **Jobs / LLM:** cron via `run_*_scheduled.sh` + `vm_sync_schedule.py`; ops endpoint + daemon-thread pattern; `backend/anthropic_adapter.py` (Haiku 4.5, tool-use, key from env) used only by Who's That Pokémon.
- **RN:** `TopTrendsBlock` in the feed (per-game top gainer carousel) is the natural teaser; a dedicated `(stack)/meta-radar` route from the drawer is the natural home. Primitives: `TopTrendsRail`, `TopMoverTile` (already renders negatives), `TrendPill`, `PillButton` tone `filter`, `SectionHeader`.

---

## 5. Proposed shape (not scheduled)

**Layer 1 — own numbers (days).** Losers + set roll-ups in `market_movers.py`; `card_views`/`scan_events` 7d-vs-prior-7d "trending with collectors"; `expansions.release_date` ⇒ "new" (≤30d) and `regulation_mark` ⇒ "rotating" for Pokémon; persist PPT `salesVelocityWeekly`/`marketTrend` and a daily `ppt_graded_signals_daily`; snapshot `population_json` daily. Surface: a Meta Radar screen with Hot / Cooling / New / Rotating pills per game, tiles reuse `TopMoverTile`.

**Layer 2 — external feeds (a week).** Nightly `run_meta_radar_vm.sh`: Limitless Play API standings → card inclusion share (7d vs 30d); Limitless HTML meta snapshot (Pokémon EN/JP, OP); YouTube RSS for ~40 channels (+ Data API view deltas); PokéBeach + DotGG + Riftbound news; ban/rotation pages weekly; eBay Browse listing counts + Scrydex sold counts for the watch set (top movers ∪ wishlisted ∪ viewed-7d ∪ meta cards). Store per entity per day in one `meta_radar_signals` table; entity resolution (set code + number, then name+set fuzzy, alias table for nicknames/romaji) is the real work.

**Layer 3 — narrative (days, optional).** One Claude call per game per day over the top-N rising/falling entities + news items ⇒ In/Out JSON with one-line reasons and `evidence_ids[]`; 24–48h sticky rule so items don't flap; show the evidence chips in the UI. Cost ~$1/day.

**Do-nots.** No Reddit/eBay/PSA/TCGplayer scraping; no PriceCharting-derived display; no Riftbound win/play rates; JP radar will lean on price velocity + PokéBeach/PokéGuardian + pokeka-win-decks (structurally weaker; say so in the UI).
