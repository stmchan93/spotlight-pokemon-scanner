# AI features: master plan (2026-11-17)

Status: PLAN FOR DISCUSSION. Nothing here is built. The user asked to agree on the plan before any implementation, then build with subagents.

Detail docs:
- In-app chat: `docs/in-app-ai-chat-plan-2026-11-17.md`
- MCP write tools / graded history / alerts / identify: `docs/mcp-phase3-write-tools-plan-2026-11-17.md`
- Marketing copy: `docs/mcp-marketing-copy-2026-11-17.md`

## Plain English: everything on the list

| # | Feature | Who it's for | Size |
|---|---|---|---|
| 1 | **In-app AI chat** (Home + Scanner button, Haiku, 3/day, saved chats) | Every app user | ~4 days |
| 2 | **Chat can do things** (add card, change qty/condition, watch), user taps Confirm | App users | ~1 day |
| 3 | **Graded price history** ("how has my PSA 10 moved?") | Chat + MCP | ~½ day (code already ported; needs a tool arg + test) |
| 4 | **Price alerts** ("tell me when this drops under $40"), push notification | Chat + MCP + app | ~2–3 days |
| 5 | **MCP write tools** (same actions from Claude/ChatGPT) | Claude/ChatGPT users | ~1 day after #2 |
| 6 | **Snap to identify in MCP** (photo in Claude → card + price) | Claude/ChatGPT users | ~1–2 days |
| 7 | **MCP launch kit**: "Use with AI" settings screen, Connected apps (revoke), ChatGPT test, prod Supabase URL check, directory submission | Distribution | ~1–2 days + review wait |
| 8 | **Ops fix**: staging/prod deploy restarts the MCP service automatically | Us | ~1 hour |

Total about **11–14 working days** of build if done one after another. Parallel subagents make it shorter in calendar time, not cheaper.

## The key idea: one shared "assistant tools" layer

The in-app chat and the MCP connector use the **same tools**. They're built once in `backend/mcp_server/tools.py` (already true for the 7 read tools) and exposed two ways:

```
                ┌──────────────────────────┐
                │  shared tools (Python)   │  read: 7 today + graded history
                │  + proposed actions      │  write: add / qty / condition / watch / alert
                └──────────┬───────────────┘
           ┌───────────────┴────────────────┐
   In-app chat endpoint               MCP server
   (Haiku, we pay, 3/day)        (user's Claude/ChatGPT pays)
   writes → Confirm button        writes → in-app "allow AI edits" toggle
           in the app               + assistant's own approval prompt
```

## Build phases and subagents

Rules for every subagent:
- Each works in **its own git worktree** (`isolation: worktree`). Never `checkout`, `reset` or `stash` in the shared tree (2026-08-06 clobbering lesson).
- Each gets a narrow brief, the contract from Phase 0, and its own tests to pass.
- Subagents don't deploy, don't OTA and don't touch prod. I review, merge, run the full suite and deploy to staging.
- One OTA at the end of each phase (OTA ships the whole working tree, so only after merges are clean).
- No new native modules are expected, so no EAS builds (push is already native).

### Phase 0: contracts (me, serial, ~½ day)
These decisions let the parallel agents not collide:
- Chat API contract: request/response JSON for `POST /api/v1/assistant/messages`, threads list/delete.
- Proposed-action format (the shape both the chat and the MCP use for "add card", "watch", "alert").
- New DB tables: `assistant_threads`, `assistant_messages`, `assistant_usage`, `price_alerts`.
- Tool descriptions + system prompt draft.
- A fake-backend fixture so the RN agent can build the UI before the backend exists.

### Phase 1: foundations (4 subagents in parallel)
| Agent | Builds | Done when |
|---|---|---|
| A. Chat backend | Endpoint, Haiku tool loop, saved threads, 3/day limit, spend cap flag, PostHog events | Tests pass; a scripted conversation works against a test DB |
| B. Chat app UI | Chat screen, thread list, card tiles, "N left today", AI button on Home + Scanner (tray context), using the Phase 0 fixture | Typecheck/lint/tests pass; screenshots on the dev route |
| C. Price alerts backend | `price_alerts` table, after-sync checker, push via existing deal-alert path, create/list/delete endpoints | Tests pass incl. "fires once per crossing" |
| D. Small backend items | Graded history arg on `get_price_history`; deploy script restarts `spotlight-mcp` | Tests pass |

### Phase 2: actions + integration (3 subagents in parallel)
| Agent | Builds |
|---|---|
| E. Proposed actions | Write tools returning proposed actions (add/qty/condition/watch/alert) in the shared layer; app Confirm cards call existing endpoints |
| F. Alerts app UI | "Price alerts" list in Settings (see/delete); alert Confirm card in chat |
| G. MCP writes + launch kit | MCP write tools behind the "allow AI edits" toggle; "Use with AI" + Connected apps screens |

### Phase 3: quality + identify (2 subagents + me)
| Agent | Builds |
|---|---|
| H. Test set | ~26 questions graded against staging; prompt/tool-description fixes |
| I. identify_card for MCP | Photo → candidates, own daily cap, nothing persisted as a label |
| Me | Full suite, staging deploy + MCP restart, OTA to staging, live walkthrough with you |

### Phase 4: production (only with your explicit approval)
Prod Supabase Site URL check → backend deploy (`SPOTLIGHT_PROD_CONFIRM=yes`) → flag on → OTA → ChatGPT test → directory submissions.

## Decisions (user, 2026-11-17): all answered

1. **Guests:** 1 question/day, then a sign-in prompt. Signed-in users get 3/day.
2. **MCP writes:** behind an in-app toggle, "Let AI assistants edit my collection", off by default.
3. **Delete by chat:** not in v1.
4. **Price alerts:** push only.
5. **identify_card in MCP:** included this round (Phase 3).
6. **Limit exemption:** the founder + staging testers skip the daily limit, via a server-side allowlist of user ids (`ASSISTANT_UNLIMITED_USER_IDS`, per-environment env, never hardcoded).
7. **Order:** in-app chat first (Phases 0–2); MCP extras (G, I) second.

Next step: Phase 0 contracts, once the user says go.
