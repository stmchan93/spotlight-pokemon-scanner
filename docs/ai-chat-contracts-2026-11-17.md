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
  "context": {"source": "home" | "scanner", "card_ids": ["≤20 card ids, scanner tray"]}
}
```
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
  "cards": [CardRef],             # ≤12, built from TOOL RESULTS, never parsed from text
  "actions": [ProposedAction],    # assistant only
  "suggestions": [str],           # assistant only (added 2026-11-18): 0-3 tap-to-ask follow-up prompts, each <=40 chars; [] for user messages, errors, refusals, and older rows. Tapping one = send it as the next question in the same thread.
  "created_at": ISO,
  "status": "ok" | "error"
}
CardRef = {
  "card_id", "name", "set", "number", "language",
  "image_small_url", "price_usd": float | null,
  "variant": str | null, "grader": str | null, "grade": str | null,
  "quantity_owned": int | null, "app_url"
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

Search/ranking (added 2026-11-18, MCP user tier + assistant): CardFilter gains `game` (pokemon default; onepiece/lorcana/riftbound/gundam; friendly names and a bare game name in `text` map to it) and `product` (`any` default = singles + sealed, `single`, `sealed` = `cards.supertype 'Sealed'` / `tcgp-sealed-*`). Price sorts exclude Japanese cards unless `language=Japanese`, and then rank only TCGplayer prices (a Scrydex raw-JP price is served as `price_usd: null`). `find_top_graded(filter?, grader?, grade?, owned?, limit≤20)` ranks graded slabs DB-only: current Scrydex graded cells (newest graded day ≤7d old, else the snapshot's `graded_contexts_json`), top candidates re-priced from cached verified sales (last USD sale ≤180d, `price_source: "ebay_sold"`), returning `graded_price_usd`, grader, grade, variant, as_of. Non-strict (takes a CardFilter).

Write (return a ProposedAction, change nothing): `propose_add_to_collection`, `propose_update_holding`, `propose_watch_card`. Validate params server-side before proposing: the card exists, the holding is owned, quantity ≥1, condition enum valid.

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
  suggestions_json TEXT           -- added 2026-11-18; older DBs get it via store.COLUMN_PATCHES (ALTER TABLE, idempotent)
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_thread ON assistant_messages(thread_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_messages_client ON assistant_messages(owner_user_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS assistant_usage (
  owner_user_id TEXT NOT NULL, day TEXT NOT NULL, questions INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (owner_user_id, day)
);
CREATE TABLE IF NOT EXISTS user_ai_settings (
  owner_user_id TEXT PRIMARY KEY, allow_mcp_edits INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
```
Raw tool payloads are not stored. History sent to the model = the last 10 messages of the thread (text only). Account deletion must delete the user's rows in all four tables (find the existing account-deletion path and extend it).

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
App-side PostHog (existing client): `assistant_opened{source}`, `assistant_question_sent{source}`, `assistant_limit_hit{is_guest}`, `assistant_action_confirmed{type}`, `assistant_action_dismissed{type}`. Server logs per message: tools used, rounds, tokens, cost_usd, latency_ms (stored on the message row).
