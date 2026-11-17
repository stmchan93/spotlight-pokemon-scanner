# MCP Phase 3: chat can change things (plan, 2026-11-17)

Status: PLAN ONLY. Nothing is built. This extends `docs/card-knowledge-graph-mcp-spec-2026-11-04.md` (Phase 3) and `docs/mcp-auth-plan-2026-11-04.md`.

## Plain English

Today the AI connector is **look-only**: it can read your collection, prices and art tags. Phase 3 adds four things people asked for:

| Feature | What we HAVE | What we NEED |
|---|---|---|
| **A. Add/edit cards by chat** | App endpoints already add, re-condition, re-quantity and delete collection rows (`create_deck_entry`, `set_deck_entry_quantity`, `update_deck_entry_condition`, `delete_deck_entry`). | MCP tools that call them, a "may edit" consent, and a write-capable service instead of the read-only one. |
| **B. Graded price trends** | `card_market_history` already accepts grader/grade. | One MCP tool (or a `grader`/`grade` arg on `get_price_history`). Staging writes no graded cells by design, so test against a prod DB snapshot. |
| **C. Price alerts** | Push tokens, notification prefs and deal-alert push sending all exist (deal radar). | A `price_alerts` table, a check that runs after the daily price sync, a push, plus `create/list/delete_price_alert` tools and a small in-app list. |
| **D. Snap to identify** | Scanner pipeline on the backend. | An `identify_card` tool taking an image, with its own small daily cap (~1.2 vCPU-s per scan). |

**Suggested order:** B (≈half a day, read-only, low risk) → A (2–3 days) → C (2–3 days, needs the app list screen = OTA) → D (1–2 days, CPU-capped).

## Decisions needed from you

1. **Write consent.** Supabase OAuth only supports `openid/email/profile/phone`, so there are no custom "write" scopes. Options:
   - (recommended) An app Settings toggle, **"Let AI assistants edit my collection"**, off by default and checked on every write tool. Read-only stays the default, and the trust line in the marketing copy stays true for people who don't opt in.
   - Or treat any connected assistant as able to write (simpler, weaker trust story).
2. **Delete by chat?** Recommended: **no delete tool in v1**. Add and edit only, with quantity floor 0 handled in the app. Lowers the "AI wiped my collection" risk.
3. **Alerts channel.** Push only (recommended) vs. push + email (Resend exists but adds template work).

## Guardrails (all features)

- Every tool is owner-scoped to the token's user (cross-account rule). No dev fallback identity.
- **No tool may trigger a Scrydex/eBay live refresh.** Prices come from the DB only, including alert checks.
- Write tools carry MCP `destructiveHint`/`idempotentHint` annotations, so Claude/ChatGPT ask the user before running them.
- Writes are idempotent with a client request id, so a retried chat call doesn't add two cards.
- Writes go through the same service methods the app uses, never raw SQL, so cost basis, history baselines and `sessionOwnerKey` scoping stay consistent.
- Rate limits: existing 60/min, 2,000/day; writes get a separate lower cap (suggest 200/day); `identify_card` gets about 25/day.
- Staging first; production needs explicit approval + `SPOTLIGHT_PROD_CONFIRM=yes`, as always.

## Appendix: implementation detail

### B. Graded price history
- Add `grader: Literal["PSA","CGC","BGS"] | None` and `grade: str | None` to `get_price_history` in `backend/mcp_server/app.py`, passing through to `card_market_history` (`backend/server.py:7915`).
- Apply the USD-only rule (hide, never render JPY) and `policy.py` shaping (public tier: refused).
- Tests: extend `backend/tests/test_mcp_tools.py` with a graded fixture.

### A. Write tools
- New `WritableSpotlightService` next to `readonly_service.py`: still no pricing providers and no live refresh, but writes allowed. Only write tools use it.
- Tools: `add_to_collection(card_id, quantity=1, condition="NM", grader?, grade?, collection_id?, request_id)`, `update_holding(holding_id, quantity?, condition?)`, `add_to_watchlist(card_id, variant?)`.
- Check the "AI may edit" flag (new column on the user's settings row) before every write; return a clear "turn this on in Ekalight → Settings" error otherwise.
- Add the tool names to `policy.ALL_TOOLS`; the public tier never gets them.
- Consent page (`consent_page.py`) copy: say what the assistant can read, and that editing needs the in-app toggle.
- Verify the watchlist write path first: the RN watchlist store (`apps/spotlight-rn/src/features/wishlist/watchlist-store.ts`) should show whether watches are deck rows or a separate table.

### C. Price alerts
- Table `price_alerts(id, owner_id, card_id, variant, condition, direction ['below','above'], target_usd, created_at, last_fired_at, active)`.
- Checker runs once after the daily price sync, reads stored prices only, and fires at most once per alert per crossing (re-arms when the price goes back across).
- Send through the existing push path (`_send_deal_alert_pushes` pattern in `server.py` ~5016), respecting `notification_prefs`.
- App: a minimal "Price alerts" list in Settings so users can see and delete alerts (JS-only, ships by OTA).
- Tools: `create_price_alert`, `list_price_alerts`, `delete_price_alert` (delete is fine here; it only removes an alert).

### D. identify_card
- Accept an image (base64 or URL from the chat client), run the existing raw/slab identify path, and return the top candidates with confidence. Don't persist the photo as a training label unless the user confirms (keep `predicted` and `confirmed` separate).
- Scan artifacts stay private; never echo storage URLs.
- Its own per-user cap, and it counts toward box capacity (staging is 1 slot).
