# Payments deployment runbook — 2026-05-15

Operator-facing runbook for flipping Looty payments live. Source-of-truth scope lives in [payments-mvp-plan-2026-05-15.md](/Users/stephenchan/Code/spotlight/docs/payments-mvp-plan-2026-05-15.md); this doc only covers deployment, env wiring, dashboard setup, and ops.

## 1. Overview

Payments are Stripe Connect Express, seller-managed. The seller onboards once (name/DOB/SSN/bank, ~15 min), then can scan a card → tap **Sell** → enter a price → tap **Charge**. The app generates a QR code; the buyer scans it on their phone, pays through a hosted Stripe Checkout page (Apple Pay / card), and Stripe routes funds minus a 4% application fee to the seller's connected account. The buyer does **not** need the app.

Architecture in three lines:

- **Backend** (`backend/server.py` + `backend/stripe_payments.py`): owns order rows, Stripe API calls, webhook idempotency, deck-state mutations.
- **Stripe**: hosts Connect onboarding, Checkout session, signed webhooks, payouts.
- **RN app** (`apps/spotlight-rn/`): renders QR + onboarding entry; a tiny web claim page on the backend handles post-purchase "save to my collection" via Supabase OAuth.

## 2. Env vars (backend)

> NOTE: confirm with `backend/stripe_payments.py` before final deploy. The parallel work on refunds, disputes, reconciliation, admin endpoints, and the push sender may add `ADMIN_USER_IDS`, `DISPUTE_ALERT_EMAILS`, and an Expo push key after this doc was written; grep `os.environ.get` in `backend/server.py` and `backend/stripe_payments.py` before you cut over.

| Name | Where used | Example | Required when |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | `backend/stripe_payments.py:stripe_secret_key()` | `sk_test_51N...` (test) / `sk_live_51N...` (live) | Any Stripe API call. Without it the API returns `503` and `is_stripe_configured()` is false. |
| `STRIPE_WEBHOOK_SECRET` | `backend/stripe_payments.py:verify_webhook_signature()` | `whsec_a3f...` | Webhook delivery. Wrong value → `400` signature verification failed. |
| `STRIPE_PLATFORM_FEE_BPS` | `backend/stripe_payments.py:platform_fee_bps()` | `400` (= 4%) | Optional. Defaults to `400`. Set to `0` only for local testing. |
| `SPOTLIGHT_PUBLIC_BASE_URL` | `backend/stripe_payments.py:public_base_url()` | `https://looty.34.59.188.129.sslip.io` (staging) | Checkout success/cancel URLs, claim page links, webhook target. Trailing slash stripped. |
| `SUPABASE_URL` | `backend/server.py` (auth + claim page) | `https://<project-ref>.supabase.co` | Always. Used to verify buyer/seller JWTs and to render the claim page sign-in. |
| `SUPABASE_ANON_KEY` | `backend/server.py` (claim page only) | `eyJhbGciOi...` | Claim page OAuth. Same value as `EXPO_PUBLIC_SPOTLIGHT_SUPABASE_ANON_KEY` in the RN app. |
| `SUPABASE_JWT_SECRET` *(or `SUPABASE_JWKS_URL`)* | `backend/server.py` JWT verification | `super-long-symmetric-secret` | Authenticating mobile clients. Same secret currently used for scanner endpoints. |
| `ADMIN_USER_IDS` | `backend/server.py` admin guard | `9b2e...,a40c...` (comma-separated Supabase UUIDs) | `/api/v1/admin/*` endpoints (refund/dispute ops). |
| `DISPUTE_ALERT_EMAILS` | `backend/server.py` dispute hook | `ops@looty.com,founder@looty.com` | Optional. Structured-log hook today; wire to mailer later. |
| `SPOTLIGHT_EXPO_PUSH_ACCESS_TOKEN` | `backend/server.py` push sender | `<expo access token>` | Server-driven push notifications (paid receipt, dispute alert). Generate at expo.dev → Account → Access Tokens. |

Restart the backend after editing `backend/.env` on the VM:

```bash
gcloud compute ssh spotlight-backend-vm-small --zone=us-central1-b --project=spotlight-492502 \
  --command='sudo systemctl restart spotlight-backend.service'
```

## 3. Stripe dashboard one-time setup

1. Create a Stripe account at https://dashboard.stripe.com/register.
2. Activate the account (legal entity, EIN/SSN, bank account, business address). The platform itself must be activated before Connect onboarding will work for sellers.
3. Settings → Connect → **enable Connect**. When prompted, choose **Express** (we do not use Standard or Custom).
4. Settings → Connect → Branding: set platform name to **Looty**, upload icon, brand color. Sellers see this during onboarding.
5. Settings → Connect → Onboarding options: enable individual + sole proprietorship, set country = US, currency = USD. Disable platforms/products you do not need.
6. Developers → API keys → reveal the **Secret key**. This is `STRIPE_SECRET_KEY`. Test mode key starts with `sk_test_`, live with `sk_live_`.
7. Developers → Webhooks → **Add endpoint**:
   - URL: `<SPOTLIGHT_PUBLIC_BASE_URL>/api/v1/payments/stripe/webhook`
   - Events to subscribe:
     - `account.updated`
     - `checkout.session.completed`
     - `checkout.session.expired`
     - `payment_intent.payment_failed`
     - `charge.refunded`
     - `charge.dispute.created`
     - `charge.dispute.closed`
     - `payout.paid`
   - Save, then reveal the **Signing secret**. This is `STRIPE_WEBHOOK_SECRET`.
8. Connect → Settings → Statement descriptor: set to `LOOTY` (shows on buyer's card statement). Set the support phone / URL.
9. Connect → Settings → Application fees: confirm **enabled** (we rely on `application_fee_amount` per session).

## 4. Supabase one-time setup

- Project dashboard → Authentication → **URL Configuration**:
  - Add `<SPOTLIGHT_PUBLIC_BASE_URL>/claim/*` to **Redirect URLs**.
  - Keep the existing app-scheme redirect (`spotlight://login-callback`) — the mobile app still needs it.
- Authentication → **Providers**:
  - **Apple**: must be enabled (already required for the RN app's Sign in with Apple). Confirm Services ID, key ID, team ID, private key are all populated.
  - **Google**: must be enabled (already required for the RN app's Google sign-in). Confirm OAuth client IDs for iOS, Android, and Web are populated. The claim page uses the Web client ID.
- Authentication → URL Configuration → **Site URL**: leave as the app scheme; the claim page passes its own `redirect_to` per request.

The claim page lives at `<base>/claim/<order_token>` and uses Supabase JS in-browser; it reuses `SUPABASE_URL` + `SUPABASE_ANON_KEY` directly.

## 5. Backend deploy

Backend runs on the GCE VM `spotlight-backend-vm-small` (`us-central1-b`, project `spotlight-492502`), public URL `https://looty.34.59.188.129.sslip.io`. See [distribution-and-backup-strategy-2026-05-11.md](/Users/stephenchan/Code/spotlight/docs/distribution-and-backup-strategy-2026-05-11.md) for the broader VM picture.

Update env vars and redeploy:

```bash
# 1. SSH and edit env file:
gcloud compute ssh spotlight-backend-vm-small --zone=us-central1-b --project=spotlight-492502
# on the VM:
sudo -e /home/stephenchan/spotlight/backend/.env
exit

# 2. From your laptop, run the staging deploy wrapper (pulls latest main, restarts service):
pnpm backend:deploy:staging
```

Verify the Stripe wiring is loaded:

```bash
# Should return 401 (auth required) — NOT 503 (not configured):
curl -i https://looty.34.59.188.129.sslip.io/api/v1/payments/stripe/connect/status

# Backend logs should show is_stripe_configured=True at startup:
gcloud compute ssh spotlight-backend-vm-small --zone=us-central1-b --project=spotlight-492502 \
  --command='sudo journalctl -u spotlight-backend.service -n 50 --no-pager | grep -i stripe'
```

Hit the webhook with a Stripe CLI test event to confirm signature verification works end-to-end:

```bash
stripe listen --forward-to https://looty.34.59.188.129.sslip.io/api/v1/payments/stripe/webhook
# in another terminal:
stripe trigger checkout.session.completed
```

## 6. Reconciliation cron

`backend/tools/reconcile_orders.py` sweeps any order rows still in `pending` after Stripe webhook delivery should have closed them out. Runs every 5 minutes.

Crontab entry on the VM (added by `deploy_to_vm.sh` once the script lands; verify with `sudo crontab -u stephenchan -l`):

```cron
*/5 * * * * /usr/bin/flock -n /tmp/looty-reconcile.lock /home/stephenchan/spotlight/.venv/bin/python /home/stephenchan/spotlight/backend/tools/reconcile_orders.py >> /home/stephenchan/spotlight/logs/reconcile.log 2>&1
```

Manual test:

```bash
gcloud compute ssh spotlight-backend-vm-small --zone=us-central1-b --project=spotlight-492502 \
  --command='cd /home/stephenchan/spotlight && .venv/bin/python backend/tools/reconcile_orders.py --dry-run'
```

Expected: prints any orders updated, exits `0`. If it raises `StripeNotConfiguredError`, the cron user's env isn't loading `backend/.env` — the systemd unit loads it, cron does not unless you `set -a; source backend/.env; set +a` first.

## 7. RN/Expo setup

- **Expo project ID**: `bd29d8aa-8a70-45ba-907e-f7136f2be4ff` (from `apps/spotlight-rn/app.json` → `expo.updates.url`). Slug `looty`, scheme `spotlight`, bundle `com.looty.staging`.
- **Apple Push Service certs**: Expo's managed credentials handle this. If you've never run it on this project, do once:

  ```bash
  cd apps/spotlight-rn
  eas credentials
  # → iOS → staging profile → Push Notifications: Setup
  ```

  This registers an APNs key with Expo Push Service. You only do this when the team changes or the Apple key rotates.
- **Entitlements**: `aps-environment` is added automatically by Expo when `expo-notifications` is in the plugin list and a push key is registered. Verify after the next `pnpm frontend:build:staging` by running `eas build:inspect` or checking the entitlements plist inside the IPA.
- **Test push manually**: collect the device's Expo push token (logged on app start once the registration code lands, or read via `/api/v1/devices/push-tokens` with the user's JWT) and POST to the Expo Push Tool:

  ```bash
  curl -H 'Content-Type: application/json' -X POST https://exp.host/--/api/v2/push/send -d '{
    "to": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
    "title": "Looty test",
    "body": "Push works"
  }'
  ```

  Should arrive within a few seconds on a real device (simulator pushes do not deliver to APNs).

## 8. Going from test → live mode

Stripe treats test and live as fully separate worlds: separate keys, separate webhook endpoints, separate Connect accounts. Supabase and the backend code path are identical — only Stripe-side env vars change.

Order of operations:

1. **Activate live mode** in Stripe dashboard (flip the toggle top-left). The first time, Stripe will require platform activation review for Connect — submit it days ahead of go-live, not at the last minute.
2. **Create a live-mode webhook endpoint** at `<SPOTLIGHT_PUBLIC_BASE_URL>/api/v1/payments/stripe/webhook` with the **same event list** as section 3. Stripe forces a separate endpoint per mode; the test webhook keeps working for staging.
3. **Grab the new live signing secret** (`whsec_...`). It is different from the test one.
4. **Update `backend/.env` on the VM**:

   ```
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_<live>
   # SPOTLIGHT_PUBLIC_BASE_URL unchanged
   # STRIPE_PLATFORM_FEE_BPS unchanged (400)
   ```

5. **Restart backend** (`sudo systemctl restart spotlight-backend.service`).
6. **Curl-check** `/api/v1/payments/stripe/connect/status` — still `401`, never `503`.
7. **Re-onboard each seller** in live mode. Test-mode connected accounts do not carry over. Have each seller open the app → settings → "Set up payouts" and complete the Express flow under live credentials.
8. **End-to-end smoke test** with a real $1 sale to yourself; confirm webhook delivery (Stripe dashboard → Webhooks → live endpoint → "Recent attempts") and payout schedule (Stripe → Payouts → 2-day rolling).
9. **Roll back path**: if anything looks off, edit `.env` back to `sk_test_...` + the test webhook secret and restart. The order rows from live attempts will be marked `payment_failed`/`pending`; reconcile manually.

Supabase URLs do not need to change between test and live as long as the public base URL stays the same.

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Endpoint returns `503` | `STRIPE_SECRET_KEY` not loaded into the process env | Check `backend/.env`, confirm `EnvironmentFile=` is set on `spotlight-backend.service`, then restart. `journalctl -u spotlight-backend.service \| grep is_stripe_configured` should print `True`. |
| Webhook returns `400` signature verification failed | Wrong `STRIPE_WEBHOOK_SECRET` (test vs live, or stale after rotation), **or** the backend or a proxy is rewriting the request body before signature verify | Re-copy the signing secret from the dashboard. Confirm no intermediate middleware re-encodes the JSON. Stripe expects the **raw bytes** as POSTed. |
| Buyer's claim sign-in fails (Apple/Google) | `<base>/claim/*` not in Supabase Auth → URL Configuration → Redirect URLs | Add it, save, retry. No backend restart needed. |
| Push notifications never arrive | (a) Device token not registered server-side, (b) Expo token invalidated | `GET /api/v1/devices/push-tokens` with the user's JWT — if empty, the device never registered (check RN logs for `expo-notifications` permission denial). If present, send a test push via the Expo tool; a response of `"DeviceNotRegistered"` means the token is stale (app uninstalled / reinstalled) and should be deleted. |
| Orders stuck `pending` | (a) Reconciliation cron not running, (b) Stripe webhook delivery failing | Stripe → Webhooks → endpoint → **Recent attempts**: any `4xx`/`5xx` rows? On the VM: `sudo crontab -u stephenchan -l \| grep reconcile`, then `tail -n 200 ~/spotlight/logs/reconcile.log`. |
| `application_fee_amount` rejected by Stripe | Connected account is `restricted` or `pending` | Check `account.updated` events; seller probably has an outstanding verification requirement. Surface it to the seller via the in-app onboarding nudge. |

## 10. Pre-launch checklist

Copy/paste before flipping live mode:

- [ ] LLC formed, EIN issued, business bank account open
- [ ] Stripe platform account fully activated (not in restricted mode)
- [ ] Stripe Connect platform reviewed and approved for **live** mode
- [ ] Stripe Connect branding configured (name, logo, color, statement descriptor `LOOTY`)
- [ ] Live-mode webhook endpoint created with the 8 events listed in section 3
- [ ] `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` swapped to live values in `backend/.env`
- [ ] `STRIPE_PLATFORM_FEE_BPS=400` (or whatever you've decided is final)
- [ ] `SPOTLIGHT_PUBLIC_BASE_URL` matches the URL set in the Stripe webhook
- [ ] `ADMIN_USER_IDS` populated with the operator's Supabase UUID(s)
- [ ] `DISPUTE_ALERT_EMAILS` populated
- [ ] `SPOTLIGHT_EXPO_PUSH_ACCESS_TOKEN` populated and tested with a real device
- [ ] Supabase redirect URLs include `<base>/claim/*`
- [ ] Supabase Apple + Google providers verified end-to-end on a real device (sign in, sign out, sign back in)
- [ ] Litestream backup running and tail-checked (`sudo journalctl -u litestream -n 20`)
- [ ] Local DB snapshot pulled within the last 24 h (`pnpm backend:restore:local`)
- [ ] Reconciliation cron present in `crontab -l` and last log line is `< 10 min` old
- [ ] Push notifications delivered to a real device (paid receipt path, dispute path)
- [ ] ToS (`docs/looty-marketplace-terms-2026-05-15.md`) reviewed by counsel and posted at `<base>/terms`
- [ ] Privacy policy posted and linked from the app and the claim page
- [ ] One end-to-end live-mode sale of $1 to yourself, money landed in your bank within 2 business days
- [ ] Rollback plan written down (which env vars to flip back; how to mark in-flight orders failed)
