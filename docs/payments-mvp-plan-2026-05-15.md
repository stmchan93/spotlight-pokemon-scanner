# Payments MVP plan — 2026-05-15

Vision: turn the Spotlight scanner into a point-of-sale + transaction log for collectors trading cards at shows. Seller-controlled flow, three to five taps from scan to "charged."

This doc is the source of truth for the payments MVP scope. Pricing/scan/identity specs remain in their own docs; see [docs/agent-context-index.md](/Users/stephenchan/Code/spotlight/docs/agent-context-index.md).

---

## 1. Product vision

> Two people at a card show. The seller has already done a one-time Stripe Connect onboarding (~15 min, name/DOB/SSN/bank). At the show they scan a card → tap **Sell** → enter $40 → tap **Charge**. The app shows a QR code with "$40 to Steve." The buyer holds up their phone camera, taps the QR notification, an Apple Pay sheet opens in their browser, they tap **Pay**, done. Seller's screen flips to "Paid ✓" in ~2s. Money lands in seller's bank in 2 days. Looty takes a 4% platform fee.

Three transaction types in scope for MVP:

- **Sell** — the only flow with money movement. QR → buyer pays via Stripe Checkout in a browser. Buyer does **not** need the app to pay.
- **Buy** — pure inventory logging. Scan card, enter what you paid, condition. Updates `deck_entries.cost_basis_total`. No payment flow.
- **Trade** — pure inventory logging. Scan inbound card, pick outbound card(s) from your inventory, optional cash delta. No payment flow in MVP.

### Buyer-friendly app (no Stripe required)

The existing scanner + inventory + pricing already constitutes a useful app for non-sellers. Selling is an **optional upgrade** gated on Stripe Connect onboarding; everyone else just uses the app.

Two additions make the app sticky for people who don't sell:

- **Favorites / want-list** — heart icon on card detail. A `card_favorites` row, distinct from `deck_entries` ("I want this" vs "I own this"). Created from a scan or from the card detail screen.
- **Post-purchase claim** — after a buyer pays a seller via Stripe Checkout, the success page offers "Save this card to your Spotlight collection." Sign in with Apple/Google → auto-create their `deck_entries` row with `cost_basis_total` = amount paid. Every successful sale is a user-acquisition funnel — the seller is paying you to acquire your next user.

Out of scope for MVP: in-app wallet/balance, two-user real-time trade confirmation, Tap to Pay on iPhone, escrow, shipping, sales tax collection, multi-currency, browse/search a card catalog without scanning, wishlist price-drop alerts.

---

## 2. Why this is feasible against today's app

Inventory from explore pass (2026-05-15):

| Area | State | Notes |
|---|---|---|
| Auth | ✅ Supabase (Apple + Google) | Every row scoped by `owner_user_id`. No new auth work. |
| Inventory model | ✅ `deck_entries` exists | Already has `cost_basis_total`, `condition`, `grader`, `grade`, `cert_number`. |
| Sale ledger | ⚠ `sale_events` exists | Has nullable `payment_method`, `total_price`, `currency_code` — designed for this. |
| Pricing | ✅ Vendor-first card detail in flight | Reuse for price suggestion on Sell sheet. |
| Backend | ⚠ vanilla Python `http.server` + SQLite | Workable. No webhook infra yet. |
| Payments | ❌ none | No Stripe SDK, no IAP, no orders concept. |
| KYC data | ❌ none | Stripe collects + holds; we just track onboarding status. |
| App Store | 🟢 pre-launch | No live-user migration risk. |

Net: auth + inventory are solid; the bulk of the work is adding Stripe + an orders table + the seller-side checkout UI.

---

## 3. The canonical Sell transaction (end-to-end)

```
Seller (in app)                  Looty backend           Stripe              Buyer (browser)
──────────────                   ─────────────           ──────              ───────────────
Scan card (existing)
Tap "Sell"
Enter $40, condition
Tap "Charge $40"     ─────────►  POST /v1/orders
                                 - validate seller onboarded
                                 - create order row (status=pending)
                                 ─────────────────────► createCheckoutSession
                                                        - amount=$40
                                                        - app_fee=$1.60
                                                        - transfer_data.destination=acct_…
                                 ◄───────────────────── { url, session_id }
                                 store session_id on order
                                 return { qr_url, order_id }
                       ◄────────
Display QR for qr_url
Poll order status (SSE/poll)
                                                                            Camera scans QR
                                                                            Opens Stripe Checkout in browser
                                                                            Apple Pay sheet
                                                                            Buyer taps Pay
                                                                                 │
                                                        ◄────────────────────────┘
                                                        process payment
                                                        ─────────► webhook: checkout.session.completed
                                 ◄─────────────────────
                                 verify signature
                                 idempotency check (stripe_events)
                                 mark order paid
                                 decrement deck_entries.quantity (WHERE quantity > 0)
                                 insert sale_events row (payment_method='stripe')
                                 ─────────────► push: "Sold $40"
Show "Paid ✓"        ◄────────
```

Failure modes that webhook handler must cover: `checkout.session.expired` (mark order cancelled), `payment_intent.payment_failed` (mark failed, allow retry), `charge.refunded`, `charge.dispute.created`.

### Post-purchase claim (the buyer-side acquisition funnel)

```
Stripe Checkout success
   │
   └── success_url = https://app.looty.com/claim/{order_id}?session_id={CHECKOUT_SESSION_ID}
                              │
                              ▼
        Looty-hosted web page  (served by Python backend as a single HTML route)
        - Confirms payment via session_id lookup
        - Shows card image + "You bought: Charizard 1st Ed PSA 10 — $400"
        - Two CTAs:
            [Save to my Spotlight collection]  (Apple / Google sign-in)
            [No thanks]
        │
        ▼  (on sign-in)
        - Lookup Supabase user by email (Stripe provides buyer's email)
        - If exists: link order → create deck_entries row with cost_basis = amount_cents
        - If not: create Supabase user, then same
        - Mark order.buyer_user_id = <claimed user>
        - Show "Saved ✓ — open the app to see it" with App Store / Play Store deep links
```

Notes:
- Claim is **optional** and happens **post-payment**. Payment success does not depend on it.
- Stripe Checkout already collects buyer email by default — pass it through.
- Claim window: open indefinitely. Buyer can claim weeks later by re-opening the receipt email Stripe sent them.

---

## 4. Data model changes

### New tables

```sql
-- Tracks each user's Stripe Connect Express account state.
CREATE TABLE stripe_accounts (
  user_id TEXT PRIMARY KEY,                  -- Supabase UUID
  stripe_account_id TEXT NOT NULL UNIQUE,    -- acct_…
  charges_enabled INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  requirements_due TEXT,                     -- JSON array of currently-due requirements
  country TEXT NOT NULL DEFAULT 'US',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per attempted transaction. Authoritative state lives here.
CREATE TABLE orders (
  order_id TEXT PRIMARY KEY,                 -- our UUID
  seller_user_id TEXT NOT NULL,
  deck_entry_id TEXT NOT NULL,               -- what's being sold
  card_id TEXT NOT NULL,                     -- denormalized for analytics
  amount_cents INTEGER NOT NULL,
  application_fee_cents INTEGER NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL,                      -- pending | paid | cancelled | refunded | disputed | failed
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT UNIQUE,
  qr_token TEXT NOT NULL UNIQUE,             -- short opaque token in QR URL
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  cancelled_at INTEGER,
  refunded_at INTEGER
);
CREATE INDEX idx_orders_seller ON orders(seller_user_id, created_at DESC);
CREATE INDEX idx_orders_status ON orders(status, created_at);

-- Webhook idempotency. Stripe retries; we dedupe on event id.
CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY,                 -- evt_…
  type TEXT NOT NULL,
  payload TEXT NOT NULL,                     -- full event JSON
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);

-- Buyer-side want-list. Distinct from deck_entries (which means "I own this").
CREATE TABLE card_favorites (
  user_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  note TEXT,                                 -- optional free text from the user
  source TEXT,                               -- 'scan' | 'card_detail' | 'post_purchase' (for analytics)
  PRIMARY KEY (user_id, card_id)
);
CREATE INDEX idx_card_favorites_user ON card_favorites(user_id, added_at DESC);
```

`orders` also needs an optional `buyer_user_id TEXT` column (nullable, populated when a buyer claims their purchase post-payment).

### Existing tables touched

- `deck_entries`: no schema change. Sell flow decrements `quantity`; if it hits 0, row stays (for history) but is filtered from inventory views.
- `sale_events`: populate the existing-but-unused `payment_method`, `currency_code`, `unit_price`, `total_price` columns on `checkout.session.completed`. Add `order_id` foreign key column (new migration).

---

## 5. Backend endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/payments/connect/onboard` | Create Stripe Express account if missing, return onboarding URL. |
| GET | `/v1/payments/connect/status` | Return `{ charges_enabled, payouts_enabled, requirements_due }`. |
| POST | `/v1/orders` | Create order + Stripe Checkout Session. Returns `{ order_id, qr_url }`. |
| GET | `/v1/orders/:order_id` | Seller polls/SSE for status updates. |
| POST | `/v1/orders/:order_id/cancel` | Cancel a pending order (e.g. buyer walked away). |
| POST | `/v1/orders/:order_id/refund` | Seller-initiated refund (full or partial). |
| POST | `/v1/webhooks/stripe` | Webhook receiver. Signature-verified; idempotent via `stripe_events`. |
| POST | `/v1/favorites` | Add card to user's favorites. Body: `{ card_id, note?, source }`. |
| DELETE | `/v1/favorites/:card_id` | Remove from favorites. |
| GET | `/v1/favorites` | List current user's favorites. |
| GET | `/claim/:order_id` | HTML page for post-purchase claim flow (web, not JSON). |
| POST | `/v1/orders/:order_id/claim` | Link an order to a Supabase user. Auth required. Creates `deck_entries` row. |

Webhook events handled in MVP:

- `account.updated` → update `stripe_accounts` flags
- `checkout.session.completed` → mark order paid, decrement inventory, write `sale_events`
- `checkout.session.expired` → mark order cancelled
- `payment_intent.payment_failed` → mark order failed
- `charge.refunded` → mark order refunded, optionally restore inventory
- `charge.dispute.created` → mark order disputed, email alert to platform admin

All webhook handlers must be idempotent — check `stripe_events.event_id` first; if already processed, return 200 without side effects.

---

## 6. RN screens

### New (seller-side)

- **Sell sheet** (from card detail or scan result): price input, condition picker, "Charge $X" CTA.
- **QR display screen**: full-screen QR code, amount, live status ("Waiting for buyer…" → "Paid ✓"), cancel button.
- **Stripe onboarding entry**: in Account/Settings, "Set up payments" → WebBrowser to Stripe Express → return-URL deep link → status refresh.
- **Sales history**: filter `sale_events` to `payment_method = 'stripe'`, show payout status.
- **Analytics dashboard** (Phase 4): see Phase 4 below.

### New (buyer-side, no Stripe needed)

- **Buy sheet**: similar to Sell sheet but writes to `deck_entries` with `cost_basis`. No payment.
- **Trade sheet**: scan inbound card, multi-select outbound from inventory, optional cash delta.
- **Favorites button** (heart icon) on card detail screen — toggle `card_favorites` row.
- **Favorites tab/section** showing user's want-list with current prices and a "you own X already" pill if the same card_id exists in `deck_entries`.
- **Post-purchase claim landing page** — web (not RN), served by backend. Lightweight HTML + Apple/Google web sign-in. Mobile-first responsive.

### Reused

- Camera/scan flow — unchanged.
- Card detail screen — add three CTAs (Sell / Buy / Trade) above pricing comps.
- Inventory ("Portfolio") — already exists.

---

## 7. Phased plan

### Phase 0 — Business prerequisites (1–2 weeks, mostly external)

Blocks all engineering. Run in parallel with Phase 1 design.

- Form an LLC if Looty isn't one. (~$200, days. Use Stripe Atlas or local filing.)
- Open Stripe Connect platform account; request Express access.
- Open business bank account (Mercury / Relay).
- Lawyer-drafted ToS and Privacy Policy updates: marketplace clauses, dispute policy, KYC data sharing with Stripe, platform fee disclosure. (~$2–5k.)
- Lock decisions in §9.

### Phase 1 — Seller onboarding (2–3 weeks)

Goal: a user can become a verified seller. No transactions yet.

Backend:
- Add `stripe_accounts`, `stripe_events` tables.
- Add `stripe` Python SDK, env var `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
- `POST /v1/payments/connect/onboard` (creates Express acct + onboarding link).
- `GET /v1/payments/connect/status`.
- `POST /v1/webhooks/stripe` with signature verification, idempotency, and `account.updated` handler.

RN:
- "Set up payments" entry in Account screen.
- `expo-web-browser` for Stripe-hosted onboarding flow.
- Deep link return → re-fetch status → show "Ready to sell ✅" or "More info needed" with link back to Stripe.

Validation: complete onboarding end-to-end in Stripe **test mode** with a test SSN (`000-00-0000`) and test bank (`110000000` / `000123456789`).

### Phase 2 — Sell flow + buyer checkout + claim (3–5 weeks)

Goal: a verified seller can charge a buyer via QR, and the buyer can optionally claim the purchase into a Spotlight account.

Backend:
- Add `orders` table (with nullable `buyer_user_id`); migration on `sale_events` to add `order_id`.
- `POST /v1/orders` — creates Checkout Session with `payment_intent_data.application_fee_amount` and `payment_intent_data.transfer_data.destination` (destination charges pattern — simpler refunds than direct charges).
- `GET /v1/orders/:order_id` — supports SSE or short-poll for live status.
- Webhook handlers: `checkout.session.completed`, `checkout.session.expired`, `payment_intent.payment_failed`.
- Inventory decrement guarded by `WHERE quantity > 0` in the same SQLite transaction as order update.
- `GET /claim/:order_id` — returns HTML claim page (single Python handler returning HTML string is fine for V1; no separate frontend stack needed).
- `POST /v1/orders/:order_id/claim` — authenticated; links order to buyer and creates their `deck_entries` row.

RN:
- Sell sheet UI (price entry → "Charge $X").
- QR display screen with live status.
- `@stripe/stripe-react-native` for any future client-side needs (not strictly required for QR-only flow, but install now).
- "Sale complete" confirmation with receipt.

Web (new, minimal):
- Claim landing page served by backend. Single HTML page. Supabase JS SDK for Apple/Google web sign-in. Posts to `/v1/orders/:id/claim` on success.

Validation: end-to-end happy path with Stripe test card `4242 4242 4242 4242`; test Apple Pay in sandbox; verify webhook idempotency by replaying; verify claim flow with a fresh email (creates account) and an existing user (links order only).

### Phase 3 — Buy / Trade / Favorites — buyer-side core (2–3 weeks)

Goal: make the app valuable for non-sellers. Drives retention.

- Buy sheet: writes `deck_entry_events` row with `event_type='purchase'`, updates `deck_entries.cost_basis_total`, `quantity`.
- Trade sheet: writes two `deck_entry_events` (one in, one or more out), optional `cash_delta_cents`.
- `card_favorites` table + CRUD endpoints (`POST /v1/favorites`, `DELETE /v1/favorites/:card_id`, `GET /v1/favorites`).
- Heart toggle on card detail screen.
- Favorites tab in RN: list view with current prices, "owned" pill if also in `deck_entries`, swipe-to-remove.
- No new Stripe code.
- Reuse existing scan → card detail entry point.

### Phase 4 — Analytics + share (2–3 weeks)

Goal: the "show off" feature. This is the retention loop.

Metrics to surface, per user:
- Lifetime revenue, cost, **profit** (revenue − cost basis of sold cards).
- Top 5 wins (largest profit single transactions).
- Per-show stats — populate `sale_events.show_session_id` from a "set active show" picker.
- Sell-through time (days from buy → sell).
- This-month vs last-month deltas.

Implementation:
- New `/v1/analytics/me` endpoint returning aggregated stats. All computed from `deck_entry_events` + `orders` + `sale_events`. No new ledgers.
- "Stats" tab in RN app.
- Shareable image generation: react-native-view-shot of a card-format stat block, save to camera roll or system share sheet. Spotify-Wrapped vibe.

### Phase 5 — Disputes, refunds, polish (2 weeks)

- `POST /v1/orders/:id/refund` + UI in sales history.
- `charge.dispute.created` webhook → email alert + freeze that seller's payouts (set Stripe account to `manual` payout schedule).
- `charge.refunded` webhook → update order, optionally restore `deck_entries.quantity`.
- Idempotency keys on all `stripe.checkout.Session.create` calls.
- Admin lookup endpoint behind hardcoded admin email allowlist (you).
- Expo push notifications: "You sold X for $Y", "Payout received", "Dispute filed — action needed".

### Phase 6 — Closed pilot (2 weeks elapsed, ~3 days of actual on-site work)

- TestFlight + Stripe live mode with low daily caps via Radar rules.
- 10–20 sellers at a real card show (your local Hartford/Chicago/wherever contacts).
- You attend. Watch what actually breaks. Fix in real time.
- Iterate on the QR display screen wording and the seller's mental model of "what is happening right now."

### Phase 7 — Future (post-MVP)

- **Tap to Pay on iPhone** — the magic upgrade. Requires Apple Business Manager + Stripe Terminal SDK + iOS 16.4+.
- **Two-user real-time trade confirmation** — both phones tap, both confirm, both inventories update atomically.
- **Sales tax** via Stripe Tax once GMV crosses state thresholds.
- **Wallet** (Path B from prior scoping conversation) only if cash-out friction becomes a real pain point.
- Cash App Pay, Klarna, ACH for big-ticket cards.

---

## 8. Timeline + cost

**Engineering:** 10–13 weeks solo full-time to end of Phase 6. Faster with a contractor on RN while you do backend.

| Phase | Duration | Parallelizable? |
|---|---|---|
| 0 Business | 1–2 wk | yes (mostly external) |
| 1 Onboarding | 2–3 wk | — |
| 2 Sell flow + claim | 3–5 wk | partially (RN/BE/web split) |
| 3 Buy/Trade/Favorites | 2–3 wk | yes |
| 4 Analytics | 2–3 wk | yes |
| 5 Disputes/polish | 2 wk | — |
| 6 Pilot | 2 wk | — |

Revised total: ~12–15 weeks solo full-time to end of Phase 6.

**One-time costs:** ~$3–6k (LLC, lawyer, business banking, insurance).

**Per-transaction cost (sample $40 sale):**
- Stripe: 2.9% + $0.30 + Connect fee (~0.25%) = ~$1.56
- Looty platform fee (4%): $1.60
- Net to seller: ~$36.84
- Net to Looty (pre-tax): $1.60

Sellers will compare:
- Venmo (free, but no scan/log/analytics, no buyer protection)
- eBay (~13% all-in, but no in-person UX)
- Looty (~7% all-in, in-person, scan-to-charge, analytics)

Your wedge is the integrated experience, not the fee.

---

## 9. Open decisions (lock before Phase 1)

| # | Decision | Recommendation |
|---|---|---|
| 1 | Platform fee % | 4% |
| 2 | Hold period before seller payout | 3 days (configurable in Stripe Connect settings) |
| 3 | Refund authority in V1 | Seller-only; platform escalation via email |
| 4 | Allow raw cards or slabs only | Allow raw; require "sold as-is" checkbox |
| 5 | Price sanity warning threshold | Warn if price <50% or >200% of latest priced range; do not block |
| 6 | Trade flow V1 | Single-user log only; defer two-user confirmation |
| 7 | Currency | USD only for V1 |
| 8 | Refund auto-restore inventory? | No — let seller manually adjust (avoids ghost re-listings) |
| 9 | Analytics: vanity metric for share image | "Total profit this year" + top card |
| 10 | Push notifications | Required for Phase 5; pick Expo Push or roll APNs/FCM directly |
| 11 | Post-purchase claim CTA wording | Recommend "Save to your collection — track its value over time" (focus on tracking, not ownership) |
| 12 | Claim window expiry | Recommend never; orders remain claimable indefinitely |
| 13 | Favorites cap per user | Recommend 1000 (Stripe-tier abuse signal if higher) |
| 14 | Does favoriting a card you already own surface anywhere? | No — hide heart on owned cards in V1 to avoid confusion |

---

## 10. Risks

Ranked by what's most likely to actually kill the MVP:

1. **Seller cold start.** Buyer not needing the app helps a lot, but you still need sellers at one show before launch day. Pre-onboard 5+ sellers at a single show before the pilot. This is a go-to-market problem, not engineering. (The post-purchase claim flow softens the buyer-side cold start — every paid transaction is a chance to acquire a buyer-side user — but only if they click through.)
2. **First counterfeit/condition dispute.** It will happen within the first 50 transactions. Have the dispute policy written and visible in-app before pilot. The lawyer ToS work in Phase 0 is non-optional.
3. **Stripe Radar false positives.** First-time buyer + $300+ card → flagged. Be reachable on the day of pilot to manually approve.
4. **App Store review of marketplace nature.** Apple guideline 3.1.5(a) allows P2P money transfer for physical goods, but reviewers may not read carefully. Have a written reviewer note ready when you submit.
5. **Buyer's phone doesn't have a QR scanner / camera permission off.** Fallback: short URL printed below QR (`pay.looty.app/x4k9`). Plan this in Phase 2.
6. **Webhook delivery flakiness.** Stripe retries, but if our backend is down during a retry, the order gets stuck pending. Add a reconciliation job in Phase 5 (cron that polls Stripe for orphan PaymentIntents).
7. **Inventory race conditions.** Two devices on same account selling the last copy of a card simultaneously. The `WHERE quantity > 0` guard in the SQLite transaction handles it, but write a regression test.
8. **Buyer claim flow conversion is low.** Realistic estimate: 15–30% of paid buyers will click "Save to my collection." Don't depend on this for unit economics; treat it as bonus growth. Worth A/B testing the CTA wording during the pilot.
9. **Email collision on claim.** Buyer pays with email X (in Stripe Checkout), then tries to claim using a Supabase account on email Y (Apple Sign-In often hides the real email). Decision needed: require matching emails (strict, more friction) or allow any signed-in user to claim from a one-time order link (relaxed, slight abuse surface). Recommend relaxed — claim link is single-use and only printed in the Stripe success_url.

---

## 11. Things explicitly NOT in this plan

- In-app wallet / stored balance (was "Path B" in scoping; revisit only if pilot validates volume).
- Negotiation / chat / offers.
- Shipping or logistics (this is in-person only).
- Multi-currency / international.
- Inventory across multiple sellers (no consignment, no "sell for a friend").
- Sales tax collection (track GMV by state for future compliance, but don't collect in V1).
- Custom KYC UI (use Stripe-hosted Express onboarding; do not build our own).
- Card grading or authentication services.
- Browse / search a card catalog without scanning (favorites are created from scan or card detail only in V1).
- Wishlist price-drop alerts or "seller nearby has this card" notifications.
- Two-user real-time trade confirmation (each side taps to accept; both inventories update atomically).

---

## 12. References

- [docs/spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md)
- [docs/agent-context-index.md](/Users/stephenchan/Code/spotlight/docs/agent-context-index.md)
- Stripe Connect Express docs: https://stripe.com/docs/connect/express-accounts
- Stripe Checkout Sessions: https://stripe.com/docs/payments/checkout
- App Store Review Guideline 3.1.5(a): https://developer.apple.com/app-store/review/guidelines/#payments
