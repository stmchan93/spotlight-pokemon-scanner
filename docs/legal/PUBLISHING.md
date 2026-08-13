# Publishing the legal documents to the live site

The finished documents in this folder — `terms-of-service.md` and `privacy-policy.md` — must
be published to the GitHub Pages repo **`stmchan93/ekalight-legal`** (served at
`https://stmchan93.github.io/ekalight-legal/`). That repo is **not** part of this working
tree, so publishing is a manual step for the owner.

## Current live site structure (verified 2026-08-12)

Plain HTML, no Jekyll (`.nojekyll` present), branch `main`:

| Path in repo | Live URL | Currently serving |
|---|---|---|
| `index.html` | `https://stmchan93.github.io/ekalight-legal/` | **Privacy policy — the stale June 2026 version** (predates the social layer) |
| `terms/index.html` | `https://stmchan93.github.io/ekalight-legal/terms/` | **Terms of Service — stale, last updated June 27, 2026** (no social/UGC/moderation coverage) |
| `delete-account/index.html` | `https://stmchan93.github.io/ekalight-legal/delete-account/` | Account-deletion instructions (reasonably current; claims image deletion, which the backend now implements) |
| `privacy/` | `https://stmchan93.github.io/ekalight-legal/privacy/` | **404 — does not exist** |

The **root URL is the canonical privacy policy URL** already referenced by the Play runbook
and used as the App Store privacy URL. Keep that stable.

## Steps

1. Clone the site repo: `git clone git@github.com:stmchan93/ekalight-legal.git`.
2. Convert `docs/legal/privacy-policy.md` to HTML and replace the **body content** of
   `index.html`, keeping the existing page chrome/styling. Strip the `> ⚠️ DRAFT …` blockquote
   banner — the published page must not say DRAFT. Keep the effective/last-updated dates.
3. Convert `docs/legal/terms-of-service.md` the same way into `terms/index.html`.
4. Recommended: add `privacy/index.html` containing a meta-refresh redirect to `../` so that
   the intuitive `/privacy/` path stops 404ing:
   ```html
   <!doctype html><meta http-equiv="refresh" content="0; url=../">
   <link rel="canonical" href="https://stmchan93.github.io/ekalight-legal/">
   ```
5. Review `delete-account/index.html` against Privacy Policy §9 (what is and is not deleted)
   and align the wording — in particular the not-deleted list (moderation records, archived
   deleted-comment text, access-gate email records, backups).
6. Commit and push to `main`. GitHub Pages redeploys automatically (usually under a minute).
7. Verify all three URLs render, then verify from a phone browser (App Review opens these on
   device).

## Before publishing — two dependencies

- **Counsel review recommended** (see the banner in each document). Publishing before review
  is a business decision; the documents are written to be accurate as of 2026-08-12.
- **Deletion claims**: Privacy §9 states that account deletion removes stored images. The
  backend storage sweep implementing this exists in `backend/server.py`
  (`delete_account` → `_collect_account_storage_targets` → `_delete_account_storage_objects`)
  but it must be **deployed to production** (Phase 2 of
  `docs/production-promotion-checklist-2026-08-12.md`) before real prod users are covered by
  the claim. Publish in the same window as the prod backend deploy, or after it.

## After publishing — wire the app

Separate repo task (this tree): make the Terms/Privacy links tappable in
`apps/spotlight-rn/src/features/auth/components/auth-controls.tsx` (`TermsFooter`, ~L246-259)
and add the same links to the account screen, pointing at:

- Terms: `https://stmchan93.github.io/ekalight-legal/terms/`
- Privacy: `https://stmchan93.github.io/ekalight-legal/`

These URLs also go into App Store Connect (privacy policy URL, support URL) — see
`docs/app-store-submission-2026-08-12.md`.
