# AI chat + MCP writes: build contracts (Phase 0, 2026-11-17)

Source of truth for the parallel build agents. Plan: `docs/ai-features-master-plan-2026-11-17.md`. If a contract here is wrong, STOP and report; do not silently diverge.

## Architecture decisions

1. **The chat backend lives in the MCP process** (`backend/mcp_server/`, systemd `spotlight-mcp.service`, port 8790), not in the scanner server. Reasons:
   - it already holds `ReadOnlySpotlightService` (never triggers paid Scrydex/eBay refreshes) and `CollectionTools`;
   - it's async;
   - slow LLM calls stay off the scanner process.

   Caddy routes `/api/v1/assistant/*` to 8790 (`backend/vm_caddyfile.py` `MCP_PATHS`).
2. **Auth for chat routes = the app's normal Supabase session JWT** (`Authorization: Bearer`). This is NOT the MCP OAuth token path: no `client_id` required, and **guests (`is_anonymous=true`) ARE allowed** (limit 1/day). Reuse `mcp_server/auth.py` validation with a separate config (`require_oauth_client=False`, guests allowed).
3. **Chat writes are PROPOSED, never executed server-side.** Tools return a `ProposedAction`. The app shows Confirm, then calls the EXISTING app endpoints. The chat backend only records the action's state.
4. **Price alerts already exist**: watchlist target price (`card_favorites.target_price_cents`, `watch_signals.target_hit_signal`, push via `market_alerts`). "Alert me under $X" = `watch_card` with `target_price_usd`. No new alerts table.
5. **MCP (Claude/ChatGPT) writes DO execute server-side**, because there is no app to show a Confirm button. They run only if the user turned on **"Let AI assistants edit my collection"** (default off), and they use the same validation as the app endpoints.
6. Model: **`claude-haiku-5-5`** via the official `anthropic` Python SDK (add to `backend/requirements.vm.txt` + `requirements.dev.txt`). Messages API, manual tool loop, adaptive thinking (default), `output_config.effort: "low"`, `tool_choice: auto`, `strict: true` tools, prompt caching on system + tools. Haiku has no server-side fallback: handle `stop_reason == "refusal"` with a polite message.

## Config (env, per environment; never hardcode ids)

| Var | Default | Meaning |
|---|---|---|
| `ASSISTANT_ENABLED` | `0` | Master switch; off → 503 `assistant_disabled` |
| `ASSISTANT_MODEL` | `claude-haiku-5-5` | |
| `ASSISTANT_DAILY_LIMIT` | `3` | Questions/UTC day, signed-in |
| `ASSISTANT_GUEST_DAILY_LIMIT` | `1` | Questions/UTC day, `is_anonymous` |
| `ASSISTANT_UNLIMITED_USER_IDS` | `` | Comma-separated Supabase user ids with no limit (founder + staging testers) |
| `ASSISTANT_DAILY_SPEND_CAP_USD` | `5` | Server-wide; when exceeded → 503 `assistant_busy` until next UTC day |
| `ASSISTANT_MAX_TOOL_ROUNDS` | `4` | |
| `ASSISTANT_SHARED_ANSWERS` | `1` | Shared market-answer cache (below); `0` = kill switch |
| `ANTHROPIC_API_KEY` | (exists) | Already used by `anthropic_adapter.py` |

One question = one user message that got an assistant answer. Failed or errored turns do NOT count.

## HTTP API (MCP process, JSON, camelCase is NOT used; snake_case throughout)

### `POST /api/v1/assistant/messages`
Request:
```json
{
  "thread_id": "thr_... or null (new thread)",
  "client_message_id": "uuid (idempotency: same id → same response, no double charge)",
  "text": "1..1000 chars",
  "context": {"source": "home" | "scanner", "card_ids": ["≤20 card ids, scanner tray"], "game": "pokemon|onepiece|lorcana|riftbound|gundam (optional)"}
}
```
`context.game` (added 2026-11-20, additive): the opening screen's game (Home's market game picker / the scanner's "Scanning for" lane / a catalog game page); sent on every message. Unknown strings are ignored; a non-string is 400.

### Game scope (added 2026-11-20, owner decision)
Market-wide rankings (rising, falling, new highs, lows, undervalued, trending, sets, most expensive, top graded) cover ONE game, resolved in code (`mcp_server/assistant/game_scope.py`): (1) the question names a game (an explicit "all games" = unscoped; a game Ekalight doesn't carry, e.g. MTG = unscoped with a "we don't cover it" note); (2) the thread's remembered game (`assistant_threads.game`, set when a question names a game or a market call is pinned); (3) `context.game`; (4) the game with the most collection entries (same rule as the Insights picker default; guests skip); (5) Pokémon. The model gets a "Game scope: X" note per turn, and `enforce_game` pins X on `get_market_trends`/`find_price_lows`/`find_new_highs` (top-level `game`), `find_top_graded`, rarity-scoped `find_movers`, and price-sorted `search_cards` (`filter.game`) unless the question named the model's game; calls with text/set/artist filters or owned/collection args are untouched. A scoped answer gets one deterministic "What about <game>?" chip (next collection game, else the screen's game); model chips switching games are dropped.
200:
```json
{
  "thread_id": "thr_...",
  "user_message": AssistantMessage,
  "message": AssistantMessage,
  "usage": Usage
}
```
Errors:
- 400 `{"error":"invalid_request","detail":...}`
- 401 when unauthenticated
- 429 `{"error":"daily_limit","usage":Usage}`
- 503 `{"error":"assistant_disabled"|"assistant_busy"}`
- 502 `{"error":"assistant_failed"}` (LLM or network failure; not counted)

### `GET /api/v1/assistant/usage` → `Usage`
### `GET /api/v1/assistant/threads?limit=20&cursor=` → `{"threads":[ThreadSummary], "next_cursor": str|null}` (newest first)
### `GET /api/v1/assistant/threads/{thread_id}/messages?limit=50&before=<message_id>` → `{"messages":[AssistantMessage]}` (oldest→newest)
### `DELETE /api/v1/assistant/threads/{thread_id}` → `{"deleted": true}`
### `DELETE /api/v1/assistant/threads` → `{"deleted": <count>}` (clear all)
### `POST /api/v1/assistant/actions/{action_id}` body `{"state":"confirmed"|"dismissed"}` → `{"action": ProposedAction}`
Records the user's choice AFTER the app performed (or skipped) the real write. Owner-scoped; 404 on someone else's action.

### Direct add + `POST /api/v1/assistant/actions/{action_id}/undo` (added 2026-11-20, owner review decision 2)
- A fully specified single add (explicit add + one exact printing + quantity + stated condition, or stated grader + grade) is executed server-side by the assistant tool `add_to_collection_now` (`mcp_server/assistant/direct_add.py`): `CollectionWriteTools.add_to_collection` → `create_deck_entry` with `selectionSource "assistant"`, live pricing off. No `allow_mcp_edits` gate (that toggle is for external MCP clients).
- Only when the send body carries `"capabilities": ["direct_add"]` (older app builds would show it as a Confirm card and add twice). Otherwise, and on any ambiguity (several printings and none named, condition/grade not stated in the question, a second add in the same turn, several adds in one round), the tool falls back to a normal proposal.
- Idempotency: `mcp_write_requests` key `assistant:{client_message_id}:{sha256(card_id, quantity, condition, variant_name, grader, grade)[:24]}`; the action id is derived from the same key, so a retried/replayed turn returns the stored result and never adds twice.
- The reply carries an executed action: same shape as an `add_to_collection` ProposedAction plus `state: "done"` and `undo: {deck_entry_id, quantity_added, expires_at}` (24h); the tiles are just that card with its new `quantity_owned`.
- Undo (body none) → `{"action": ...state "undone"}`. Takes back exactly `quantity_added` from that holding (holding removed when it reaches 0, via `set_deck_entry_quantity`). Owner-scoped (404), idempotent (already undone → 200), 409 `not_undoable` (not a server-made add), `undo_expired`, `cannot_undo` (holding gone).

### Pick-a-printing choice (added 2026-11-21, owner decision L023)
- When the question is a single add/update (`mcp_server/assistant/choice.py` `write_intent`: "add/put/log …", "change/update my …"; not how-tos, Watchlist/alerts, or batches like "all/these/tray"), the reply proposed/executed no action, and its tiles hold 2+ cards from THIS turn's lookups, the reply carries `choice: {kind: "pick_printing", intent: "add"|"update", quantity, condition, grader, grade, quantity_stated, condition_stated}` (add defaults: quantity 1, condition NM, null for a stated slab; update: null = not stated) and the text ends with "Tap a card below to pick the right one." (appended in code when the model didn't say it). Stored in `assistant_messages.choice_json`; never put in the shared-answer cache. Older apps ignore it and show plain tiles.
- App: on the latest reply only, a choice tile's tap sends a follow-up naming that printing ("Add Charizard ex (Obsidian Flames 228) to my collection"; stated quantity/condition/grade repeated, unstated ones left to the proposal's ×1/NM defaults) with `context.card_ids: [card_id]`; the normal propose → Confirm (or direct add → Undo) flow follows. Long-press opens the card page. The tap is a normal question (counts toward the daily limit).

### `POST /api/v1/assistant/messages/{message_id}/feedback` (added 2026-11-19)
Body `{"rating": "up"|"down"|null, "reason": null|"wrong"|"not_helpful"|"too_long"|"wrong_cards"|"other", "note": null|str (≤500 chars, trimmed; "" = null)}`. `rating` is required; `null` clears (reason/note ignored). → `{"message_id", "feedback": Feedback|null}`.
- Owner-scoped: 404 for another user's or an unknown message; 400 `invalid_request` for a user message or bad values.
- Stored in `assistant_feedback` (one row per message; clearing deletes the row). Thread delete / clear-all / account deletion remove it.
- Server-side PostHog event `assistant_feedback` (same `TurnAnalytics` sender + `environment` tag as `assistant_turn_cost`), fired only when the stored state changes: `rating` (null = cleared), `reason`, `message_id`, `thread_id`, `tools`, `cost_usd` (of that answer), `question` (≤200 chars), `answer` (≤400 chars). This is the count of record; the app's `assistant_feedback_tapped` is UI-only.
- Export for triage / eval cases: `backend/tools/assistant_feedback_export.py` (`--include-up`, `--as-cases [--format json]`).

### Types
```text
Usage = {
  "limit": int | null,            # null = unlimited (allowlist)
  "used_today": int,
  "remaining_today": int | null,
  "resets_at": "ISO-8601 UTC midnight",
  "is_guest": bool
}
ThreadSummary = {
  "id", "title" (first question, ≤60 chars),
  "updated_at", "last_message_preview" (≤120 chars)
}
AssistantMessage = {
  "id", "thread_id", "role": "user" | "assistant",
  "text": str,                    # plain text; light markdown allowed: **bold**, bullet lines
  "cards": [CardRef],             # ≤12, built from TOOL RESULTS, never parsed from text. 2026-11-20: = the model's show_cards selection (see "Tile selection")
  "cards_label": str | null,      # assistant only (2026-11-20): section header above the tiles, ≤40 chars
  "cards_view_all": {"screen": "watchlist", "total": int} | null,  # assistant only (2026-11-20): "View all N" under a capped (≤8) Watchlist preview
  "actions": [ProposedAction],    # assistant only
  "suggestions": [str],           # assistant only (added 2026-11-18): 0-3 tap-to-ask follow-up prompts, each <=40 chars; [] for user messages, errors, refusals, and older rows. Tapping one = send it as the next question in the same thread.
  "charts": [PriceChart],         # assistant only (added 2026-11-18): 0-2; [] for user messages, errors, refusals, and older rows
  "choice": PrintingChoice | null,  # assistant only (added 2026-11-21): tiles are tap-to-pick printings, see "Pick-a-printing choice"
  "sets": [SetRef],               # assistant only (added 2026-11-20): ≤6 set tiles for set-level answers; [] otherwise and on older rows. Older apps ignore it.
  "created_at": ISO,
  "status": "ok" | "error",
  "feedback": Feedback | null     # added 2026-11-19: the caller's 👍/👎 on an assistant answer; always null on user messages
}
Feedback = {"rating": "up" | "down", "reason": str | null, "note": str | null, "updated_at": ISO}
SetRef = {"set_id": str, "name": str, "game": str, "logo_url": str | null, "symbol_url": str | null,
          "change_pct": float | null, "window": "7d" | "30d" | "90d" | null, "release_year": str | null}
          # Set tiles (2026-11-20): when get_market_trends ran and the answer text names its rising/falling sets,
          # those sets become set tiles (mention order) and card tiles drop to the cards the text itself names
          # (a charted card stays). Tap opens /catalog/expansion/<set_id>?game=<game>. Not on proposals.
CardRef = {
  "card_id", "name", "set", "number", "language",
  "image_small_url", "price_usd": float | null,
  "variant": str | null, "grader": str | null, "grade": str | null,
  "quantity_owned": int | null, "app_url"
}
PriceChart = {                    # one per distinct get_price_history series the model called this turn,
                                  # built from the TOOL RESULT (never model text); omitted when <2 points
  "card_id", "name",
  "variant": str | null, "condition": "NM".."DMG" | null (null when graded),
  "grader": str | null, "grade": str | null,
  "range": "30d" | "90d" | "1y",
  "points": [{"date": "YYYY-MM-DD", "usd": float}],   # oldest first, USD only, <=90 (downsampled, ends kept)
  "source": "tcgplayer" | "scrydex" | null           # source of the newest point
}
ProposedAction = {
  "id": "act_...", "type": "add_to_collection" | "update_holding" | "watch_card",
  "summary": "Add Charizard ex (Obsidian Flames 228/197) · NM · ×1",   # server-built, shown on the button card
  "params": {...},                # below
  "state": "proposed" | "confirmed" | "dismissed"
}
```

### ProposedAction params → existing app call (api-client `packages/api-client/src/spotlight/repository.ts`)
| type | params | App performs on Confirm |
|---|---|---|
| `add_to_collection` | `card_id`, `quantity` (≥1), `condition` (`NM`/`LP`/`MP`/`HP`/`DMG`, null for slabs), `variant_name`\|null, `grader`\|null, `grade`\|null, `collection_id`\|null | existing create-deck-entry call (`POST /api/v1/deck/entries`) with `selectionSource: "assistant"` |
| `update_holding` | `holding_id` (deck entry id), `quantity`\|null (≥1; no delete in v1), `condition`\|null | existing quantity / condition calls |
| `watch_card` | `card_id`, `variant`\|null, `target_price_usd`\|null | `setCardFavorite(card_id, true, {variant})`, then `setCardFavoriteTarget(...)` if target set (cents = round(usd*100)) |

Backend changes this implies (Agent A):
- `server.create_deck_entry`: map `selectionSource "assistant"` → confirmation source `add_assistant`.
- `CollectionTools` holding summaries gain `holding_id` (deck entry id). Add it to `policy.USER_CARD_FIELDS`. The public tier never sees it.

## Assistant tools (what Haiku sees)

Read (wrap `CollectionTools`, owner = request user): `search_cards`, `get_card`, `get_my_collection`, `get_my_watchlist`, `get_portfolio_summary`, `find_missing`, `get_price_history` (incl. `grader`/`grade`), `list_facets`. Same arguments as the MCP tools.

Market reads (added 2026-11-17, also MCP user tier only): `find_price_lows` (cards ≥25% below their window high and within 5% of the window low; reads the `price_lows` tables written by `backend/price_lows.py` on the ops prewarm hook after each price sync) and `get_market_trends` (Top Trends gainers from the scanner's persisted `market_movers_latest` runtime setting + Market Watch set trends from `meta_pulse_*`). Both DB-only, USD-only.

New highs (added 2026-11-19, MCP user tier + assistant, non-strict): `find_new_highs(filter?, game?, owned?, window="1y"|"90d", limit≤20)` reads `price_highs` / `price_highs_runs`, written by the same `price_lows.py` job and the same single history scan. A card qualifies when its current market price is within 2% of the window high, that high was first reached in the last 7 days, and it is ≥15% above the window low; ranked by `high_date` desc, then `pct_above_low`. Same guardrails as lows (one USD source/printing, no Scrydex raw-JP, distinct-price + step guards, $10 floor, ≥30 days). Sealed is included (filter.product), Japanese excluded unless language=Japanese. Returns `high_usd`, `high_date`, `low_usd`, `pct_above_low`, `days_covered`, `as_of`. Graded sales are NOT included: the eBay sold-comp cache only holds slabs someone opened (≤25 comps each), too sparse for a "highest sale" signal.

Search/ranking (added 2026-11-18, MCP user tier + assistant): CardFilter gains `game` (pokemon default; onepiece/lorcana/riftbound/gundam; friendly names and a bare game name in `text` map to it) and `product` (`any` default = singles + sealed, `single`, `sealed` = `cards.supertype 'Sealed'` / `tcgp-sealed-*`). Price sorts exclude Japanese cards unless `language=Japanese`, and then rank only TCGplayer prices (a Scrydex raw-JP price is served as `price_usd: null`). `find_top_graded(filter?, grader?, grade?, owned?, limit≤20)` ranks graded slabs DB-only: current Scrydex graded cells (newest graded day ≤7d old, else the snapshot's `graded_contexts_json`), top candidates re-priced from cached verified sales (last USD sale ≤180d, `price_source: "ebay_sold"`), returning `graded_price_usd`, grader, grade, variant, as_of. Non-strict (takes a CardFilter).

Write (return a ProposedAction, change nothing): `propose_add_to_collection`, `propose_update_holding`, `propose_watch_card`. Validate params server-side before proposing: the card exists, the holding is owned, quantity ≥1, condition enum valid.

Tile selection (added 2026-11-20, owner review decisions 1/6/7): strict tool `show_cards(cards: [{card_id, variant|null, grader|null, grade|null}], label: str|null)` (all params required/nullable, so zero optional params). The model calls it once, ideally in the same message as its answer (then no extra round; one lone show_cards round doesn't spend the lookup budget). Ids resolve only against refs the server produced this turn, the scanned `context.card_ids`, or earlier tiles in the thread; anything else is dropped and reported back as `not_shown`. Without show_cards: tiles = cards whose name appears in the answer text (a number in the text narrows to that printing), else the charted card, else every tool card (the old behaviour). A chart always keeps its card's tile. Tiles drop same-language reprints sharing an artwork (`card_art_group_members`; EN/JP counterparts stay); art searches return one printing per artwork (filter language, else English, preferred). Since 2026-11-20 (eval 2) the server then enforces tile discipline in code (`choose_tiles`), because the model over-selects: a charted card → just that card (2 charts narrow to the printing the text pins), plus other card names in the text and a selected scanned card; an answer that asks the user to choose ("Which … ?") keeps the candidates; when the text names cards, tiles = the selection ∩ named cards (one printing per name unless the text pins a number/set), plus named cards the selection missed (resolved from tool results, e.g. when show_cards picked nothing); exceptions: Watchlist previews, a count the user asked for ("my 5 most valuable"), and list answers ("Here are…", "including…", "led by…") over search/find_missing/collection results; proposal cards always show; an executed direct add shows its one card. show_cards ids missing their game prefix (`FBL-242` for `lorcana~FBL-242`) resolve when unambiguous. Tiles from `find_price_lows`/`find_new_highs` carry `sparkline: {range, points: [usd, ≤30], change_pct}` from stored history (DB-only). `get_my_watchlist` items are sorted targets-first (closest to target), then market price desc; an all-Watchlist tile set is capped at 8 with `cards_view_all`.

Scanner context: when `context.card_ids` is present, tell the model "The user is looking at these scanned cards: …" with name/set/number/price per card (resolved server-side, ≤20).

## System prompt (draft; Agent A owns final wording)
Final wording lives in `backend/mcp_server/assistant/engine.py` `SYSTEM_PROMPT` (rewritten 2026-11-18: takeaway-first explanations, feature mentions limited to a fixed list of real features, and a trailing `<followups>` block that `split_suggestions` strips into `AssistantMessage.suggestions`). The draft below is historical.
```
You are Ekalight's card assistant inside the Ekalight app. You help collectors with their Pokémon (and other TCG) card collection, card prices, what they're missing, and finding cards.
- Use the tools for every fact about cards, prices, or the user's collection. Never invent a card, price, or holding. If a price is null, say Ekalight has no price for it.
- Prices are USD from Ekalight's daily market data, not live. Never show yen or other currencies.
- Call the user's watched cards their "Watchlist" (never "wishlist").
- To change anything (add a card, change quantity/condition, watch a card or set a price alert), call a propose_* tool. The user must tap Confirm. Never say it's done.
- You can't delete cards, sell, list, or buy. Say so briefly.
- Off-topic requests (not cards/collecting/this app): decline in one sentence.
- Be brief: 1-4 short sentences or a short list. The app shows card tiles for cards you looked up, so don't repeat every detail.
```

## Database (SQLite, shared DB; owner-scoped; created idempotently at MCP-process startup AND in `backend/schema.sql`)
```sql
CREATE TABLE IF NOT EXISTS assistant_threads (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, title TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_threads_owner ON assistant_threads(owner_user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
  role TEXT NOT NULL, text TEXT NOT NULL, cards_json TEXT, actions_json TEXT,
  status TEXT NOT NULL DEFAULT 'ok', client_message_id TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, tools_used TEXT,
  created_at TEXT NOT NULL,
  suggestions_json TEXT,          -- added 2026-11-18; older DBs get it via store.COLUMN_PATCHES (ALTER TABLE, idempotent)
  tool_calls_json TEXT            -- added 2026-11-18: compact 'name(key=value)' per tool call, for history provenance (same patch path)
  charts_json TEXT                -- added 2026-11-18 (PriceChart list); same COLUMN_PATCHES path
  cards_label TEXT, cards_view_all_json TEXT  -- added 2026-11-20; same COLUMN_PATCHES path
  sets_json TEXT                  -- added 2026-11-20 (SetRef list); same COLUMN_PATCHES path
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_thread ON assistant_messages(thread_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_messages_client ON assistant_messages(owner_user_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS assistant_usage (
  owner_user_id TEXT NOT NULL, day TEXT NOT NULL, questions INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (owner_user_id, day)
);
CREATE TABLE IF NOT EXISTS assistant_feedback (   -- added 2026-11-19
  message_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  rating TEXT NOT NULL, reason TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_ai_settings (
  owner_user_id TEXT PRIMARY KEY, allow_mcp_edits INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
```
Raw tool payloads are not stored. History sent to the model = the last 10 messages of the thread: text, plus (2026-11-18) a model-only `[Looked up with: ...; Cards shown: ...]` note after each prior assistant answer built from `tool_calls_json` (fallback `tools_used`) and `cards_json`, so the model doesn't disown earlier tool-backed answers. Never shown to users. Account deletion must delete the user's rows in all five tables (incl. `assistant_feedback`) (find the existing account-deletion path and extend it).

### Shared market answers (added 2026-11-20, cost lever)
Market-wide questions ("Undervalued cards", "What's trending…") have one answer for everyone until prices change, so it is computed once (`mcp_server/assistant/shared_answers.py`, table `assistant_shared_answers(key PK, question_norm, version, reply_json, hits, created_at, expires_at)`, not owner-scoped).
- Eligible request: first message of a new thread (`thread_id` null), no `context.card_ids`.
- Stored only when the turn is `ok`, has no actions/tool errors/round-limit, carries no quality flag (`slow`/`expensive` are ignored), and every tool call was a market-wide read (`get_market_trends`, `find_price_lows`, `find_new_highs`, `list_facets`, `search_cards`, `find_top_graded`) with `owned` unset/`any`, no collection/holding args, and no user data in the result (`my_holdings`, `resolved_owned_*`, `quantity_owned`); `show_cards` is allowed; at least one non-`list_facets` lookup.
- Key = sha256(normalized question, scope = resolved game (`game:<id>`, `game:all_games`, `game:unsupported`; knowledge answers `knowledge|game:<id>`), data version, model + system-prompt hash). The game-switch chip is recomputed for each replaying asker. Normalization: lowercase, trim, collapse whitespace, curly→straight quotes, strip trailing punctuation, then exact match or `QUESTION_ALIASES`. Data version = `price_lows_version_token` (newest price date + `pricing_sync_generation`); rows also expire after 24h.
- Hit: no LLM call; the reply (text, cards without `quantity_owned`, cards_label, charts/sparklines, suggestions, tool_calls for history) is saved in the user's own new thread with its own ids, `cost_usd`/tokens 0, `assistant_messages.cached = 1`; it still counts as a question (daily limit) and is served even past the spend cap. Log line and PostHog `assistant_turn_cost` carry `cached: true` (misses `cached: false`).
- Eval: `backend/tools/assistant_eval.py` bypasses the cache by default (`--no-shared-cache`); `--shared-cache` turns it on.

## MCP write tools (Agent C)

Registered only on the `user` tier, annotated `destructiveHint: false`, `idempotentHint: false`; Claude/ChatGPT ask before calling.
- `add_to_collection(card_id, quantity=1, condition="NM", variant_name?, grader?, grade?, collection_id?, request_id)`: `request_id` makes retries idempotent.
- `update_holding(holding_id, quantity?, condition?)`: no delete; quantity ≥1.
- `watch_card(card_id, variant?, target_price_usd?)`

Each call:
1. checks `user_ai_settings.allow_mcp_edits = 1`, else a ToolError: "Turn on 'Let AI assistants edit my collection' in Ekalight → Settings → Use with AI";
2. calls the same `SpotlightScanService` methods the app endpoints use (`create_deck_entry`, quantity/condition setters, `set_card_favorite`, `set_card_favorite_target`) under the request identity, through a write-capable service that STILL has live pricing disabled (subclass like `ReadOnlySpotlightService`);
3. has its own rate limit (200 writes/day/user).

App endpoints for the toggle (main backend, `server.py`):
- `GET /api/v1/me/ai-settings` → `{"allow_mcp_edits": bool}`
- `POST /api/v1/me/ai-settings` `{"allow_mcp_edits": bool}`

## App surfaces (Agent B / C)

- **B**:
  - AI button on Home (`src/app/(tabs)/index.tsx` → `PortfolioScreen` header area) and on Scanner (`scanner-screen.tsx`, passes tray card ids as `context`).
  - Chat screen (new route, e.g. `src/app/(stack)/assistant.tsx` + `src/features/assistant/`), thread list, card tiles (tap → card detail), ProposedAction cards (Confirm/Dismiss → existing repository calls → `POST /actions/{id}`), "N left today" + limit-reached state (guests: sign-in prompt), error/retry.
  - Repository methods + mock data in `packages/api-client`. Design system only; Watchlist naming.
- **C**: a "Use with AI" screen from Settings/You: what it is, the staging/prod MCP URL with a copy button, 3 steps for Claude, the "Let AI assistants edit my collection" toggle, and a Connected-apps list with revoke if the Supabase JS client exposes OAuth grants (check `@supabase/supabase-js` version first; if not available, show "manage in Claude/ChatGPT" text and report).

## Analytics
App-side PostHog (existing client): `assistant_opened{source}`, `assistant_question_sent{source}`, `assistant_limit_hit{is_guest}`, `assistant_action_confirmed{type}`, `assistant_action_dismissed{type}`, `assistant_feedback_tapped{rating, reason}` (UI only; the server's `assistant_feedback` event is the count of record). Server logs per message: tools used, rounds, tokens, cost_usd, latency_ms (stored on the message row).

Quality flags (2026-11-19): `mcp_server/assistant/flags.py` tags every answer with deterministic review flags (`assistant_messages.flags_json`, `flags` on AssistantMessage; app ignores it). The server `assistant_turn_cost` event carries `flags`, `flag_count`, `question` (≤200), `answer_preview` (≤300), `thread_id`, `message_id`. Review: `python3 backend/tools/assistant_review.py --db <db> --since 7d [--flag code] [--limit N] [--sample N]`.
