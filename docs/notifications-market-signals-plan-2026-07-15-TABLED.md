# Notifications & Market Signals — Weekly Recap + Push

> **STATUS: TABLED 2026-07-15** — fully specced and ready to pull forward.
> Superseded in priority by the "since you added it" per-card change display
> (Robinhood-style), which needs no notification infra.

## Context

Retention is the app's weakest measured link (e.g. Roman: 60 scans + 39 price checks on signup day, never returned). The fix: a **market-signals notification system** — the app notices things about YOUR cards and tells you, weekly, honestly.

**Decisions made (2026-07-14):** V1 = weekly recap + market signals · delivery = in-app recap card + **push** (no email — user preference) · **Sunday 6pm PT** digest · recap card at top of Collection screen · wishlist target-hits **deferred to M4** (fully specced below; UI is ~1.5–2.5 of its ~2.5–3.5 days, doesn't clear the "only if easy" bar).

**Signal catalog:** sell-side (collection): trailing-window highs + 30d momentum; buy-side (wishlist): trailing lows + 90d drawdowns; plus weekly value change + top movers.

**Guardrails (agreed, all implemented as named, individually-tested helpers):** price floor $5 · significance ≥12% vs window median · cap 5 signals ranked by |move|×value · raw-lane signals fenced to `cards.language='en'` (kills the ~1028 broken raw-JP prices; graded-lane JP stays eligible) · headlines say "highest in the N months we've tracked it" (N = min(12, history)), NEVER "all-time" · information not advice · **empty recap ⇒ no push** (quiet weeks are silent).

## Milestones

### M1 — Backend: schema, signal engine, weekly job, API
1. **Schema** (idempotent patches per `_add_column_if_missing` / CREATE IF NOT EXISTS pattern, `catalog_tools.py:295`):
   - `user_push_tokens(owner_user_id, expo_push_token, platform, created_at, last_seen_at, revoked_at, PK(owner,token))`
   - `user_notification_prefs(owner_user_id PK, weekly_recap_enabled DEFAULT 1, target_hits_enabled DEFAULT 1, updated_at)` — absent row = defaults ON
   - `user_recaps(id, owner_user_id, period_end_date, payload_json, created_at, seen_at, dismissed_at, push_sent_at, push_tickets_json, UNIQUE(owner, period_end_date))` + index — **signals live inside payload_json, no per-signal rows** (Litestream churn ≈ 1 row/user/week); prune >8 weeks in the job.
   - `payload_json` = API contract: `{periodEndDate, collection{valueCents, weekChangeCents, weekChangePercent}, topMovers[3], sellSignals[], buySignals[]}` with per-signal `{kind, cardId, name, imageUrl, marketCents, movePercent, headline}`.
2. **Signal engine — new `backend/market_signals.py`** (pure functions over a connection, testable like catalog_tools):
   - One pass for ALL users: deck_entries + card_favorites → dedup distinct (card, context) requests (favorites are card-level; use default raw lane matching the wishlist list price resolver, `card_favorites()` server.py:15117) → **one call** to `price_history_rows_for_cards_batched(..., days=400)` (`catalog_tools.py:5020`) — the entire heavy-read story.
   - Per-context stats: current, d7/d30 ago, window high/low/median, 90d high, months_tracked. Predicates: `trailing_high` (≥window high, ≥3mo history), `momentum_30d` (≥+10%), `trailing_low`, `drawdown_90d` (≤−10%). Guardrails applied in order, then rank+cap per user.
   - Recap assembly: weekly value change = Σ qty×(current−d7) over owner entries (same batched rows, no dashboard recompute); top 3 movers by |weekly $ change|.
3. **Weekly trigger:** new `backend/run_weekly_recap_vm_scheduled.sh` cloning `run_sync_vm_scheduled.sh` (gate: `vm_sync_schedule.py --cron "0 18 * * 0" --timezone America/Los_Angeles`), second crontab entry → `POST /api/v1/ops/run-weekly-recap?token=…` — new ops endpoint copying `/api/v1/ops/prewarm-portfolio` verbatim (server.py:16329–16346: token check → daemon thread → `{"status":"started"}`), `?dryRun=1` supported. Worker modeled on `prewarm_portfolio_dashboards` (server.py:13808): own connection, best-effort, no heavy-read semaphore (two queries, Sunday 6pm off-peak, 5h after the 1pm sync).
4. **API** (all `_require_request_identity()`, owner-scoped): `GET /api/v1/recaps/latest` · `POST /api/v1/recaps/{id}/seen` · `POST /api/v1/recaps/{id}/dismiss` (dismissed excluded from /latest; other-owner id → 404) · `GET|POST /api/v1/notifications/prefs` · `POST /api/v1/notifications/push-tokens` (upsert, bump last_seen) · `POST /api/v1/notifications/push-tokens/revoke`.
5. **Tests:** `test_market_signals.py` (every guardrail isolated: floor, significance, JP fence excludes raw-JP but passes graded-JP, cap ranking, months_tracked cap + "never all-time" headline, favorites default-lane resolution) · `test_weekly_recap_job.py` (one row/user, idempotent re-run, prune, dryRun writes nothing, isolation) · `test_notification_prefs.py` / `test_push_tokens.py` (defaults-when-absent, upsert, revoke, cross-user 404s).

### M2 — RN in-app recap (ships OTA immediately after M1 deploys)
1. **api-client:** `WeeklyRecap`/`RecapSignal`/`RecapMover`/`NotificationPrefs` types (integer cents) + repository methods (`getLatestRecap`, `markRecapSeen`, `dismissRecap`, prefs get/set, push-token register/revoke) with defensive normalizers copied from `getCardFavorites` style (repository.ts:4673).
2. **`src/features/portfolio/components/recap-card.tsx`:** design-system primitives (`SurfaceCard` shell, `SectionHeader`s, subtle `IconButton` dismiss); sections: weekly value change → top movers → sell-side signals → buy-side signals (empty sections render nothing; one status element per row, never stacked). Props: `recap`, `onDismiss`, `onPressCard(cardId)` → PDP, `onEnablePush` (M3 hook).
3. **Mount** in `portfolio-screen.tsx` listHeader **between `PortfolioBalanceHeader` (:575) and chartWrap (:587)**. New `use-weekly-recap.ts` hook: fetch on mount + AppState→active (mirrors `AccessGateProvider` refresh pattern; deliberately NOT piggybacked on access status). `markRecapSeen` once on first render; optimistic dismiss.
4. **Account screen:** "Weekly recap notifications" Switch modeled on the show-mode toggle (`account-screen.tsx:112` — optimistic flip, revert+Alert on failure) → `setNotificationPrefs`.
5. **Tests:** recap-card sections/dismiss/copy fixtures; portfolio-screen mount/absence; normalizer malformed-payload tests.
6. **Ship:** backend deploy (M1) → `pnpm frontend:update:staging` (OTA).

### M3 — Push (needs a native build through the release gate)
1. **RN:** add `expo-notifications` (native module → `pnpm frontend:build:staging`; NEVER ship via OTA). `use-push-registration.ts`: permission → `getExpoPushTokenAsync` → register; silent re-register on app-open only if already granted; revoke on sign-out. **Permission UX: contextual, never on launch** — first RecapCard shows a one-time footer CTA "Get this recap as a Sunday notification" → OS prompt; account Switch is the second entry (denied → Settings deep-link Alert). Push deep-links `{"url":"/portfolio"}` via a root-layout response listener; recap card is already first thing on that screen.
2. **Backend — new `backend/expo_push.py`:** plain HTTP POST to `https://exp.host/--/api/v2/push/send`, ≤100/batch, no SDK. Weekly job final step: for push-eligible recaps (signals>0, `push_sent_at IS NULL`, prefs allow, live token): title "Your Spotlight week", body `"Your week: +$84 · Umbreon +12% · 2 cards near 12-month highs"`. Set `push_sent_at` BEFORE dispatch (at-most-once); store ticket ids. Token hygiene: `DeviceNotRegistered` on tickets → revoke now; next weekly run checks last week's receipts and prunes again.
3. **Tests:** `test_expo_push.py` — batching, body assembly, DeviceNotRegistered revocation, skip paths (prefs off / empty signals / revoked tokens), `push_sent_at` idempotency; injected mock transport (per `test_scrydex_adapter_helpers.py` style). Manual staging-device end-to-end.

### M4 — Wishlist target hits (DEFERRED — specced for pull-forward)
Two columns on card_favorites (`target_price_cents`, `target_triggered_at`) · `PUT /api/v1/card-favorites/{cardId}/target` + list-response extension · third post-sync curl block in `run_sync_vm.sh` → daily eval ops endpoint (fire on downward crossing, 30d re-arm, immediate push, respects `target_hits_enabled`) · `TargetPriceSheet` UI from wishlist rows + PDP (~1.5–2.5d of the ~2.5–3.5d total). Not built now.

## Verification

- Backend: `cd backend && ./run_all_tests.sh` (or targeted pytest); `POST /api/v1/ops/run-weekly-recap?token=…&dryRun=1` (logs counts, writes nothing) then real run + `sqlite3 … "SELECT owner_user_id, period_end_date, length(payload_json) FROM user_recaps"`; confirm a broken raw-JP card appears in no payload; re-run → no duplicates, no re-push.
- RN: mobile tests + typecheck; simulator: card renders between balance header and chart, dismiss persists, seen round-trips. M2 via `pnpm frontend:update:staging`; M3 via `pnpm frontend:build:staging` + real-device push test (receive Sunday push → tap → land on portfolio with card visible).
- Deploy order: backend (M1) → OTA (M2) → binary when convenient (M3).

## Risks (managed)

Litestream churn bounded (1 row/user/week, no per-signal rows, 8-week prune) · VM load ≈ one Insights-path batched read at Sunday 6pm off-peak · duplicate-push prevention via UNIQUE(owner, period) + push_sent_at-before-send · token hygiene dual-pruned · no per-user timezone (PT for all, env-overridable) · JP fence over-excludes healthy raw-JP (accepted v1; revisit with raw≤slab sanity check) · native-build coupling isolated to M3.
