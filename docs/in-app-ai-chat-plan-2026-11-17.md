# In-app AI chat ("Ask Ekalight"): plan (2026-11-17)

Status: PLAN, not built. Decisions below were made by the user on 2026-11-17.

## Plain English

An AI button on the **Home** and **Scanner** screens opens a chat. Users ask about their cards ("What's my collection worth?", "What am I missing from Surging Sparks?", "Which of these is worth grading?") and get an answer with tappable card tiles. The chat can also **do** things, such as add a card or watch a card, but only after the user taps **Confirm**. Chats are saved. Free users get **3 questions a day**.

It runs on **Claude Haiku 5.5** (decided; it's cheap) and reuses the same 7 data tools the MCP connector uses.

## Decisions (user, 2026-11-17)

| Question | Decision |
|---|---|
| Where's the button | Home tab + Scanner screen |
| Model | Claude Haiku 5.5 (`claude-haiku-5-5`) |
| Free limit | ~3 questions/day ("something low") |
| Chat history | Saved |
| Can it change things | Yes: write actions included |

## What we HAVE vs what we NEED

| Piece | Have | Need |
|---|---|---|
| Card/collection/price lookups | ✅ 7 tools in `backend/mcp_server/tools.py`, tested and live on staging | Nothing; call them directly |
| "Your data only" + no paid Scrydex calls | ✅ App auth (`RequestIdentity`), `ReadOnlySpotlightService` pattern | Reuse it |
| Add card / change qty / watch card | ✅ Existing app endpoints (`create_deck_entry`, `set_deck_entry_quantity`, `update_deck_entry_condition`, `set_card_favorite`) | Nothing new server-side (see Write actions) |
| Talking to Claude | ⚠️ `backend/anthropic_adapter.py` (urllib, one-shot, Haiku 4.5) | A chat loop with tools, on Haiku 5.5 |
| Chat screen | ❌ | New RN screen + 2 entry buttons |
| Saved chats | ❌ | 2 SQLite tables |
| Daily limit + cost tracking | ❌ | Counter + PostHog events |
| A paid tier to lift the limit | ❌ No premium system found in the app | Later; v1 is 3/day for everyone |

**Estimate: ~5 days** (backend 2, app 2, write actions + testing 1). Ships behind a server flag, staging first. App parts go out by OTA.

## How one question works

1. The user sends a question. The app posts it to `POST /api/v1/assistant/messages` with `thread_id`; from the Scanner, it also sends the tray's card ids as context.
2. The backend checks the daily limit, loads the thread's recent messages, and calls Haiku with the tools.
3. Haiku asks for tools (usually 1–3 rounds); the backend runs them on our DB, owner-scoped, DB-only.
4. The backend saves the answer and returns `{text, cards[], proposed_actions[], remaining_today}`.
5. The app shows the text, card tiles built from **tool results** (never from Claude's text, so prices are always real) and any Confirm buttons.

## Write actions: always user-confirmed

Write tools **don't change anything on the server**. When Claude decides to "add Charizard ex to your collection", the tool returns a *proposed action*, and the app shows a card: "Add Charizard ex (Obsidian Flames 228/197), NM, ×1 → [Confirm]". Tapping Confirm calls the **existing** app endpoint, the same one the "Add" button uses.

Why: there's no new write code to secure or test, a misread request can't silently change a collection, and cost basis, history baselines and owner scoping stay exactly as the app already handles them.

v1 actions:
- add to collection (card, printing, condition or grade, qty, collection)
- change quantity or condition of a holding
- add to or remove from Watchlist

Not in v1: delete holdings, price alerts (they need the alerts table from `docs/mcp-phase3-write-tools-plan-2026-11-17.md`), selling or listing.

## Scanner entry point

On the Scanner screen the AI button passes the current tray's card ids, so users can ask "which of these is worth the most?" or "are any of these worth grading?" without typing card names.

## Limits and cost

- **3 questions/day per user** (UTC day, counted server-side, shown as "2 left today"). One question = one user message, however many tool rounds it takes.
- Per question: at most 4 tool rounds, capped answer length, low effort, and prompt caching on the instructions + tools.
- Haiku 5.5 is $0.10 / $0.50 per million tokens in/out (prompts under 100K tokens). A typical question (~15K in, ~1K out) costs **~0.2¢**. Worst case at 3/day: ~0.6¢ per user per day, or about $6/day per 1,000 daily users who max out.
- A server-wide daily spend cap flag shuts the feature off if something goes wrong.

## Saved chats

- Tables: `assistant_threads(id, owner_user_id, title, created_at, updated_at)` and `assistant_messages(id, thread_id, owner_user_id, role, text, cards_json, actions_json, created_at)`. Owner-scoped like every account table.
- Raw tool payloads are not stored (stale prices, size); store the answer + the card ids shown.
- Users can delete a thread or all threads. Account deletion removes them.
- History sent to Claude: the last ~10 messages of the thread.

## Rules for the assistant (system prompt)

- Cards, collections, prices and the app only; anything else gets a polite decline.
- USD only; never show yen. Say "Watchlist", never "Wishlist".
- Never invent prices or cards; only state what tools returned. If a price is null, say there's no price.
- Prices are Ekalight's daily market data, not live.
- Writes only as proposed actions; never claim something was added before the user confirms.

## Quality check before launch

A test set: the 6 marketing questions + ~20 real-sounding questions (set completion, vibe search, JP twins, "is this worth grading", ambiguous card names, add-to-collection requests), run against the staging test account and graded by hand. Haiku must pick the right tool and make no price mistakes. If it fails on a category, fix the prompt or tool descriptions first, and only then consider a bigger model.

## Analytics (PostHog)

`assistant_question` (entry point, tools used, rounds, tokens, cost, latency), `assistant_limit_hit`, `assistant_action_proposed`, `assistant_action_confirmed`. Founder excluded as usual.

## Build order

1. **Backend** (~2 days): tables, endpoint, chat loop with the 7 tools, limits, flag, tests. Official `anthropic` Python SDK (new VM dependency) or extend `anthropic_adapter.py`; decide at build time.
2. **App** (~2 days): chat screen, thread list, card tiles, AI button on Home + Scanner, "N left today", OTA to staging.
3. **Write actions + test set** (~1 day): proposed-action cards wired to existing endpoints; run the test set.
4. Staging soak → production needs explicit approval (backend deploy + OTA + flag).

## Resolved (user, 2026-11-17)

- Guests (anonymous accounts): **1 question/day**, then a sign-in prompt.
- Founder + staging testers: **no daily limit**, via the `ASSISTANT_UNLIMITED_USER_IDS` allowlist.
- No delete by chat in v1. Alerts are push only.
- Paid tier: none exists yet; the limit is a server setting, so a future premium plan can raise it without an app update.
