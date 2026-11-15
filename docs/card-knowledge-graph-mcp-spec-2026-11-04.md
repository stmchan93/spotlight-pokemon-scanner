# Card Knowledge Graph + Collection-Aware MCP Server — Spec (2026-11-04)

Status: **SPEC ONLY — not built.** Pokémon first; other games later.

## Plain English

**What it is.** Two pieces that work together:

1. **Card knowledge graph.** We run a vision model over every card's art once and record what is *in* the picture: which Pokémon appear (including background cameos), the scene (beach, rain, night), the mood (sleeping, eating), the art style, and the dominant colors. Combined with what we already store (artist, set, rarity bucket, EN↔JP links, similar-art neighbours), this lets anyone search cards by what they look like: *"every card with Pikachu sleeping"*.
2. **Collection-aware MCP server.** A small server that lets Claude, ChatGPT and other AI assistants use Ekalight as a tool. The user logs in with their Ekalight account, and then their AI can search the graph, read **their** collection and prices, and work out what they are missing: *"Which beach-themed cards don't I own, and what would the cheapest five cost?"*

**Why together.** On its own the MCP server is "my collection plus prices", which Collectr's API could copy quickly. The art graph is what nobody else has. The core of the product is `find_missing`: graph matches minus what the user owns gives a shopping list, and a shopping list leads to wishlist adds and marketplace clicks.

**What we have vs. what we need.**

| Have (today) | Need (this spec) |
|---|---|
| ~44k Pokémon cards with images (23,552 EN + 20,561 JP in the local DB) | Art tags per card (new table + one-time tagging batch) |
| `artist` (449 distinct), `national_pokedex_numbers_json`, types, supertype | "Who/what is in the picture", beyond the card's own Pokémon |
| Rarity buckets (`catalog_tools.RARITY_BUCKET_KEYS`) | Search endpoint that filters on tags plus these existing fields |
| `card_language_links` (EN↔JP), `card_similar` (art neighbours) | Art groups, so a reprint or EN/JP pair is tagged once |
| `deck_entries` / `collections` / `card_favorites`, all owner-scoped | MCP server + OAuth login |
| DB-backed prices (TCGCSV main, Scrydex conditions/graded) | Nothing new; read from the DB only, **never** trigger a live refresh |
| `anthropic_adapter.py` (already calls Claude for Who's That Pokémon) | A batch tagging script |

**Cost, in one line.** Tagging every Pokémon card once costs **about $10 (Haiku) to $300 (Opus)**; the likely pick, Sonnet, is **about $170–280**. New sets add under $5 a month after that. Running the MCP server costs almost nothing extra, because the user's AI subscription pays for the thinking and we only answer database reads. Engineering: **about 2 weeks** for all three phases.

**How it makes money.**
- **Pro feature:** "Ask your collection anything" in ChatGPT and Claude, plus theme search in the app.
- **Getting found:** a listing in the ChatGPT and Claude app/connector directories puts Ekalight in front of collectors who already use those assistants.
- **Marketplace clicks:** every "missing" card links to TCGplayer/eBay through the existing `marketplace-urls.ts`, so we earn on any click that has affiliate tagging (check what's currently tagged).
- **Search traffic (from Phase 1 alone):** public theme pages ("Every sleeping Pokémon card", "All Arita beach cards") that Google can index.

**Who already does this (checked 2026-11-04):**

| Who | What | Overlap |
|---|---|---|
| **IllustratedBy** (illustratedby.com) | Art search over 22,874 EN cards with Cameo, Sleeping, Rain, Food, Night, City tags, plus artist following. No collection, prices or API seen. Publishes an `llms.txt`. | **Very close to Phase 1.** The art-tag idea alone isn't new. |
| **TCG Cameo Finder** (Ko-fi) | Paid desktop tool: search a Pokémon, see the cards it appears in. Community-grown database. | Cameo search only |
| Elite Fourum cameo list | Community list of English cameos | Free, manual |
| **tcg-mcp**, **CardShowData MCP**, **TCG Vault HQ**, pokemontcg MCPs | Open-source/API-key MCP servers: card lookup, prices (pokemontcg.io / PriceCharting), local collection files | **Overlaps Phase 2's price lookup.** None reads a real app account. |
| Data APIs: Scrydex ($29–399/mo), PokemonPriceTracker (free 1k calls/mo, paid up to 20k/day), pokemontcg.io, TCG API ($50–100/mo) | Catalog + price APIs | Not art search, not collections |
| Collectr | Lists an API + Discord bot. No public pricing or MCP found. | Could copy Phase 2 quickly |

**What that means.** Neither half is unique on its own: IllustratedBy has art search, and hobby MCPs have price lookups. What nobody has is **both, tied to a real account**: art search across *your* collection, `find_missing` with prices, EN + JP, and later the scanner. Our edge is the combination, not the tags. That makes Phase 2 (the account link) the real product, and Phase 1 the ingredient that makes it worth connecting. Before claiming better art search, compare a sample of tags against IllustratedBy's.

**Order.** Phase 1 tagging + in-app theme search → Phase 2 read-only MCP → Phase 3 write tools + scanner. Phase 1 pays for itself even if MCP flops.

**Scrydex terms (read 2026-11-04, scrydex.com/terms — the page is undated and changes take effect on posting, so archive a copy):**

| Use | Verdict | Why |
|---|---|---|
| Send card images to Claude to tag them (Phase 1) | **OK** | Nothing in §4 forbids processing. §9: card art and trademarks belong to their third-party owners, and Scrydex claims no ownership. Same category as the SigLIP2 embeddings we already compute for the scanner. The tags are new data we create, not "extracting datasets". |
| In-app theme search + public theme pages | **OK** | Same as how the app already shows Scrydex catalog data to our users. |
| MCP server for **our own logged-in users** (Phase 2) | **Likely OK, confirm** | It's our app's data shown to our users through another screen. Stay clear of §4 "redistribute, mirror" and "substitute backend / wholesale data source": owner-scoped, capped results, rate-limited, no bulk catalog dump. |
| Open developer API, or licensing the graph to third parties | **Needs written OK** | §4 resale/redistribution/sublicensing requires written authorization. Workaround (as in the Treasure plan): key on `tcgplayer_id` + set code + number and ship only our own tags, no Scrydex names or images. |
| Benchmark built on Scrydex outputs | **Avoid** | §4 forbids "benchmark". |

**Open questions to answer before building:**
1. **Scrydex:** add one line to the unsent Scrydex email asking them to confirm the MCP use above is fine. Nothing blocks Phase 1.
2. **TCGCSV/TCGplayer terms:** may prices be shown inside a third-party AI app? Main raw prices are TCGCSV, not Scrydex, so this matters more for Phase 2.
3. **Supabase OAuth server:** confirm Supabase's OAuth 2.1 server feature is available on our plan. Otherwise we build a small authorization shim (Appendix C).

---

## Appendix A — Tag schema

### A.1 What the model tags vs. what we compute ourselves

| Facet | Source | Why |
|---|---|---|
| `artist`, `set`, `rarity_bucket`, `language`, `types`, `main_pokemon` (dex numbers) | **Existing catalog columns** | Already correct; never ask the model |
| `palette` (dominant colors) | **Computed locally** (Pillow quantize → nearest named color) | Free and deterministic |
| `appearing_pokemon` | **Vision model** | Background cameos are the main new information |
| `characters` (trainers/people) | Vision model | |
| `scene`, `weather_time`, `activity`, `mood`, `objects`, `art_style`, `composition` | Vision model, **fixed vocabulary** | Fixed values make the tags searchable and stable |
| `alt_text` (one sentence) | Vision model | Accessibility + SEO page copy |
| `themes` | **Derived server-side** from tags (mapping table) | Can be changed without re-tagging |

### A.2 Fixed vocabularies (v1, enforced with structured-output enums)

- `scene`: beach, ocean_underwater, river_lake, forest, jungle, field_meadow, flowers_garden, mountain, cave, desert, snow_ice, volcano, sky_clouds, space_stars, city_street, town_village, indoor_home, bedroom, kitchen_food, restaurant_cafe, shop_market, school_library, lab, stadium_arena, festival_fair, ruins_temple, abstract_background, other
- `weather_time`: day, sunset_sunrise, night, rain, snow, storm, fog, rainbow, none_visible
- `activity`: sleeping, eating, cooking, playing, swimming, flying, running, battling, posing, reading, celebrating, resting, hugging_group, hiding, other
- `mood`: cozy, cute, funny, dramatic, fierce, peaceful, spooky, melancholy, festive, majestic
- `objects` (max 8): food, drinks, sweets, umbrella, books, toys, balloons, flowers, gifts, lanterns, pokeballs, instruments, vehicles, furniture, bed_pillow, tableware, trees, rocks, water_splash, other
- `art_style`: painterly, watercolor, pencil_sketch, anime_cel, cgi_3d, papercraft, clay_model, pixel, graphic_flat, photo_composite, mixed
- `composition`: full_art_scene, framed_window, character_closeup, panorama, group_shot, text_heavy

`appearing_pokemon` entries: `{ "name": str, "dex": int|null, "role": "main"|"secondary"|"background"|"cameo", "confidence": 0-1 }`. Names are resolved to dex numbers server-side against the catalog's Pokémon name list. If a name doesn't resolve, the tag is dropped, never invented.

### A.3 Tables (backend SQLite, in the existing migration style)

```sql
-- One row per illustration. Reprints and EN↔JP pairs share an art group and are tagged once.
CREATE TABLE IF NOT EXISTS card_art_groups (
    art_group_id TEXT PRIMARY KEY,          -- = canonical (usually EN) card_id
    representative_card_id TEXT NOT NULL REFERENCES cards(id),
    tags_json TEXT NOT NULL,                -- full model output (A.2) + palette
    alt_text TEXT,
    tagger_model TEXT NOT NULL,             -- e.g. claude-sonnet-5-5
    prompt_version TEXT NOT NULL,           -- bump → re-tag
    vocab_version TEXT NOT NULL,
    review_state TEXT NOT NULL DEFAULT 'auto', -- auto | human_ok | human_fixed
    tagged_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_art_group_members (
    card_id TEXT PRIMARY KEY REFERENCES cards(id),
    art_group_id TEXT NOT NULL REFERENCES card_art_groups(art_group_id),
    link_source TEXT NOT NULL               -- self | language_link | reprint_similar
);
CREATE INDEX IF NOT EXISTS idx_art_members_group ON card_art_group_members(art_group_id);

-- Flattened facet values for search: (facet, value) → art groups.
CREATE TABLE IF NOT EXISTS card_art_tags (
    art_group_id TEXT NOT NULL REFERENCES card_art_groups(art_group_id),
    facet TEXT NOT NULL,                    -- scene | activity | appearing_pokemon | ...
    value TEXT NOT NULL,                    -- 'beach' | 'sleeping' | dex '25' | ...
    role TEXT,                              -- appearing_pokemon only
    confidence REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY (art_group_id, facet, value)
);
CREATE INDEX IF NOT EXISTS idx_art_tags_facet_value ON card_art_tags(facet, value, art_group_id);

CREATE TABLE IF NOT EXISTS art_themes (     -- derived; editable without re-tagging
    theme TEXT NOT NULL,                    -- 'cozy_home', 'beach_day', 'food', 'rainy_day'
    facet TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (theme, facet, value)
);
```

**Building art groups (before tagging):**
1. EN↔JP: every pair in `card_language_links` joins its EN card's group.
2. Reprints: same artist + normalized base name + `card_similar` score ≥ a high threshold. The threshold is tuned on a hand-checked sample; when unsure, keep cards in separate groups (tagging twice costs less than mis-merging).
3. Everything else is its own group.
Expected result: about 25–30k groups instead of 44k cards. The cost table uses the 44k worst case.

Index tables are built **offline** by the tagging script, never at server startup (see the price-history crash-loop lesson).

### A.4 Tagging pipeline

`backend/tools/tag_card_art.py` (new):
1. Select art groups with no tags, or whose `prompt_version`/`vocab_version` is stale.
2. Fetch the image (`image_url`), downscale to 768px on the long edge, and compute the palette locally.
3. Submit via the **Message Batches API** (50% off): image + fixed system prompt (vocab) + `output_config.format` JSON schema with A.2's enums. `effort: low`.
4. Parse the results, keyed by `custom_id` (= art_group_id), resolve Pokémon names to dex numbers, then write the groups, members and flattened tags in one transaction.
5. Run it nightly after the catalog sync, so new sets get tagged automatically.

**Quality gate (before the full run):** hand-label 200 cards (half modern full-art, half vintage/framed). Run Haiku 5.5, Sonnet 5.5 and Opus 5.5 on them (<$5 total). Use the cheapest model that reaches **≥90% precision on `appearing_pokemon` (non-main)** and **≥85% on `scene`**. Below 0.6 confidence, a tag is stored but not used for search.

---

## Appendix B — MCP tool definitions

Transport: **Streamable HTTP** (the remote transport ChatGPT and Claude require), served at `/mcp` by a small Python MCP SDK process on the backend VM, which calls existing service functions directly. Every tool is owner-scoped through the authenticated `RequestIdentity.user_id` (owner-scoping rule). Reads are DB-only: **no tool may trigger a Scrydex/eBay live refresh.**

| Tool | Phase | Annotations | Purpose |
|---|---|---|---|
| `list_facets` | 2 | read-only | Vocabularies + counts, so the AI knows what it can filter on |
| `search_cards` | 2 | read-only | Graph search with optional owned/not-owned filter |
| `get_card` | 2 | read-only | One card: details, tags, price, my holdings |
| `get_my_collection` | 2 | read-only | My items, filterable by the same facets |
| `get_portfolio_summary` | 2 | read-only | Value, change over range, top movers |
| `find_missing` | 2 | read-only | Theme/filter matches I don't own, cheapest first, with buy links |
| `get_price_history` | 2 | read-only | Price trend from the DB price-history cells |
| `add_to_wishlist` / `add_to_watchlist` | 3 | write, idempotent | Write back into the app |
| `identify_card` | 3 | read-only | Photo → card via the scanner (counts against scan capacity) |

### Shared filter object (`CardFilter`)

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "text": { "type": "string", "description": "Free text over name, set, artist, alt text" },
    "pokemon": { "type": "array", "items": { "type": "string" }, "description": "Names or dex numbers; matches main OR appearing" },
    "pokemon_role": { "type": "string", "enum": ["any", "main", "background_or_cameo"] },
    "artist": { "type": "string" },
    "scene": { "type": "array", "items": { "type": "string" } },
    "weather_time": { "type": "array", "items": { "type": "string" } },
    "activity": { "type": "array", "items": { "type": "string" } },
    "mood": { "type": "array", "items": { "type": "string" } },
    "art_style": { "type": "array", "items": { "type": "string" } },
    "palette": { "type": "array", "items": { "type": "string" } },
    "theme": { "type": "string", "description": "A theme id from list_facets" },
    "set": { "type": "string" },
    "rarity_bucket": { "type": "array", "items": { "type": "string", "enum": ["sir","illustration","ultra","secret","shiny","promo","standard","other"] } },
    "language": { "type": "string", "enum": ["English", "Japanese", "any"] },
    "price_min_usd": { "type": "number" },
    "price_max_usd": { "type": "number" }
  }
}
```

Facet values are validated against `list_facets`; unknown values return an error listing the valid ones, so the AI can correct itself.

### Tool signatures

```text
list_facets() -> { facets: { [facet]: [{ value, count }] }, themes: [{ id, label, count }] }

search_cards(filter: CardFilter, owned?: "any"|"owned"|"not_owned" = "any",
             sort?: "relevance"|"price_asc"|"price_desc"|"newest" = "relevance",
             limit?: 1..50 = 20, cursor?: string)
  -> { results: [CardSummary], next_cursor?, total_estimate }

get_card(card_id: string)
  -> CardSummary + { tags, alt_text, similar: [card_id], language_pair?: card_id,
                     my_holdings: [{ condition, grader, grade, quantity, cost_basis_usd }] }

get_my_collection(filter?: CardFilter, collection_id?: string,
                  sort?: "value_desc"|"gain_desc"|"added_desc" = "value_desc",
                  limit?: 1..100 = 50, cursor?: string)
  -> { items: [HoldingSummary], total_value_usd, next_cursor? }

get_portfolio_summary(range?: "7d"|"30d"|"90d"|"1y" = "30d")
  -> { value_usd, change_usd, change_pct, top_gainers: [HoldingSummary x5], top_losers: [x5] }

find_missing(filter: CardFilter, collection_id?: string, budget_usd?: number,
             limit?: 1..50 = 20)
  -> { missing: [CardSummary + { buy_links: { tcgplayer?, ebay? } }],
       owned_count, total_matching, cheapest_completion_usd? }

get_price_history(card_id: string, range?: "30d"|"90d"|"1y" = "90d",
                  condition?: "NM" = "NM")
  -> { points: [{ date, usd }], source }

CardSummary    = { card_id, name, set, number, language, rarity_bucket, artist,
                   image_small_url, price_usd?, price_source, app_url }
HoldingSummary = CardSummary + { quantity, condition, grader?, grade?, value_usd, gain_usd? }
```

Rules:
- **USD only.** If a price exists only in JPY, `price_usd` is null and the card stays in results without a price. Never return yen.
- `app_url` deep-links to `spotlight://` / the web card page, so every answer can route back into Ekalight.
- Results are capped and paginated; no tool returns a whole collection in one call.
- Rate limits: per user, 60 calls/min and 2,000/day. `identify_card` (Phase 3) gets its own small daily cap, because a scan costs ~1.2 vCPU-seconds.

### Tool descriptions (what the AI reads)

Keep them short and literal, e.g. `find_missing`: *"Cards matching the filter that the user does not own, cheapest first. Use for 'what am I missing', set/theme completion, and shopping lists. Prices are USD and come from Ekalight's stored market data."*

---

## Appendix C — Auth

- MCP requires OAuth 2.1 + PKCE, with protected-resource metadata at `/.well-known/oauth-protected-resource`.
- **Preferred:** Supabase Auth's OAuth 2.1 server (verify plan availability). The MCP server validates the resulting JWT with the existing `SupabaseRequestAuthenticator` (JWKS) and maps it to `RequestIdentity.user_id`.
- **Fallback:** a small authorization endpoint on the backend that runs the normal Supabase login in a browser page and issues a scoped token (scopes `collection:read`, `wishlist:write`).
- **MAU guard:** the OAuth flow signs in an *existing* account only. It never creates an anonymous user or calls `signUp()`. Token refreshes count toward MAU for that same user, which is expected and not a duplicate.
- **Consent screen** lists exactly what the AI can read and write. Users can revoke access from app Settings.
- **Guest accounts:** not eligible. They must claim an account first, which is also a conversion lever.

---

## Appendix D — Cost estimate

### D.1 One-time tagging (Pokémon, worst case 44,113 cards, no art-group dedupe)

Per card: image at 768px long edge ≈ 560 tokens (≈ w×h/750) + ~850-token system prompt/vocab ≈ **1,400 input tokens**; JSON output + low-effort thinking ≈ **500 output tokens** (up to 1,000 if thinking runs long). Batch API = 50% off list price.

| Model | List $/MTok (in/out) | Batch cost, 500 out-tok | Batch cost, 1,000 out-tok |
|---|---|---|---|
| Claude Haiku 5.5 | $0.10 / $0.50 | **~$9** | ~$14 |
| Claude Sonnet 5.5 | $2 / $10 | **~$172** | ~$282 |
| Claude Opus 5.5 | $4 / $20 | **~$343** | ~$563 |

Art-group dedupe (~25–30k groups) cuts these by roughly 30–40%. The 200-card model bake-off costs under $5.

### D.2 Ongoing

| Item | Cost |
|---|---|
| New sets (~200–400 new cards/month) | < $5/mo even on Sonnet |
| Vocab/prompt upgrade (full re-tag) | Same as D.1, only when we choose to |
| Palette extraction | $0 (local CPU) |
| MCP serving | ≈ $0 marginal: DB reads on the existing VM; the user's AI pays for its own tokens |
| Prices | $0 extra: DB only, no live Scrydex credits (credit rule) |
| Scanner (`identify_card`, Phase 3) | CPU on the scan box; capped per user |

### D.3 Engineering

| Phase | Work | Estimate |
|---|---|---|
| 1 | Art groups, tagging script, bake-off, tag tables, `/api/v1/cards/search` facet filters, in-app theme chips | 4–5 days |
| 2 | MCP server (read-only tools), OAuth, consent screen, rate limits, directory submissions | 4–5 days |
| 3 | Write tools, `identify_card`, theme SEO pages | 2–3 days |

---

## Appendix E — Later (not v1)

- **Free-text art search with SigLIP2's text tower.** The runtime index is adapter-projected (show-benchmark lesson), so it is not text-aligned; this would need a separate un-projected image index. Tags first.
- **Other games** (One Piece, Lorcana, …): same pipeline with per-game vocab.
- **Theme collecting in the app:** "My Themes" progress, which reuses the set-completion design (deferred spec).
- **Licensing the graph** to creators and Discord bots once the terms answers are in.
