# Resend + Supabase Custom SMTP — Auth Email Setup

_Created 2026-06-26._

## Why

Supabase's **built-in email sender is capped at 2 emails/hour for the entire project** (fixed, dev-only). That is unusable in production: a third signup-verification / password-reset / resend in any hour — across all users — silently fails. We send auth email through **Resend** via Supabase's custom-SMTP setting.

Decision context: see memory `project_auth_email_provider` — Resend now (free 3k/mo, $20 Pro = 50k/mo), AWS SES reserved for high-volume product email later. GCP has no native email service, so there is no "stay in Google" alternative.

## Prerequisite (current blocker)

A **domain we control** for the "from" address (e.g. `no-reply@ekalight.com`). You cannot send auth email from a Gmail/free mailbox — deliverability tanks and providers block it. Confirm the **Ekalight domain is registered** before starting. Everything below is dashboard/DNS work, not code.

## Steps

1. **Resend account + domain**
   - Create a Resend account; **Add Domain** → enter the Ekalight domain.
   - Resend shows DNS records (SPF/`TXT`, DKIM `CNAME`s, optional DMARC). Add them at the domain's DNS host. Wait for Resend to show the domain **Verified** (minutes to a few hours).

2. **Resend SMTP credentials**
   - In Resend → **SMTP** (or **API Keys** → create a key used as the SMTP password). Note:
     - Host: `smtp.resend.com`
     - Port: `587` (STARTTLS) — or `465`. Avoid 25.
     - Username: `resend`
     - Password: the Resend API key.

3. **Supabase dashboard → Authentication → Emails → SMTP Settings**
   - Toggle **Enable Custom SMTP** on.
   - Sender email: `no-reply@ekalight.com`; Sender name: `Ekalight`.
   - Host/Port/User/Pass from step 2.
   - Save.

4. **Raise the auth email rate limit** (Supabase → Auth → Rate Limits)
   - Default project email cap is low; with custom SMTP it's configurable. Raise the **hourly email** and **OTP** limits to match expected signup volume. Keep the **per-address `max_frequency` at 60s** — the app's resend cooldown is built around it (`verify-code-screen.tsx`, `RESEND_COOLDOWN_SECONDS = 60`).

5. **Branding (optional)** — update the Supabase email templates (confirm signup, reset password, magic link) with Ekalight copy/logo.

## Verify

- Trigger a real **signup** with a test address → confirm the verification email arrives from `no-reply@ekalight.com`, lands in **inbox** (not spam), and the code works.
- Trigger **forgot password** → confirm reset email + code path.
- In the app's verify screen, confirm **Resend email** is disabled for 60s and re-enables without a 429.
- In **Resend → Logs**, confirm the sends are recorded (delivered, not bounced).

## Scaling notes

- Auth-only volume stays small (logins send nothing). Resend free → $20 Pro covers a large user base.
- When product email arrives (price-drop alerts, portfolio digests, wishlist-in-stock) — 10–100× auth volume — **split senders**: keep auth on Resend, send bulk from the Python backend via **AWS SES** ($0.10/1k). Separate reputation protects auth deliverability. Note GCP blocks port 25 → use SES port 587/2525 from the VM.
