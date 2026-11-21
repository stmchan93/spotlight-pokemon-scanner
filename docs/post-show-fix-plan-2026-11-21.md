# Post-show fix plan (2026-11-21)

Source: PostHog (prod, internal excluded, 10/21–11/20), 55 Replay Vision sessions, prod scan logs (read-only), and four parallel code investigations. Replay Vision summaries misread screens several times (an invented error message, a "collection duplicate" that was the scan tray, a misread card number), so every item below is backed by code, logs or data unless marked *suspected*.

## Plain English: what to fix, in order

| # | Fix | Why | Impact | Size | Ships by |
|---|---|---|---|---|---|
| P0 | **Card backs match a $3–4k Mew.** Block the 6 placeholder cards now; re-embed them from real art; stop future placeholder images by class | 6 scan-index images are the same card-back picture (verified sha256 `503854c5…`). Scanning a card back (or an empty frame) returns Mew R/G/B ($3,391–$4,317) at random | 431 scans, 81 users since Aug; tray totals of $42k; one $4,041 entry saved | 5 min (block) + ½ day (systemic) | prod data change + restart (block); backend deploy (systemic) |
| P1 | **ADD silently does nothing after a guest signs in mid-scan** | Replay + PostHog: ~10 ADD taps after sign-in, zero add events, collection stays $0 | Every guest who signs in from the tray (unknown count; instrumentation first) | ½–1 day incl. repro | OTA |
| P2 | **One-tap alternative + printing dropdown on the tray row** | 9.1% of scans with a selection are corrected; 84% of the time the right card was already in the list, 51% at #2; 14% of multi-printing adds switch printing (mostly → Reverse Holo) | Vendors' #1 time sink; 62 users, 3 vendors = half | 1–2 days | OTA (+ small backend deploy to log printing) |
| P3 | **Shutter: queue the tap instead of dropping it**, with a pulse/haptic and a reason on the event | 95 of 103 blocked taps = previous capture still processing | 44 users / 30 days, rage taps | ½ day | OTA |
| P4 | **First scan for new users**: games tooltip no longer covers "Tap to scan" (show it after the first scan); "Scan a card at this booth" on event/vendor pages during a live show; cache event + vendor data offline | 44% of installs ever scan; never-scanned users retain at 5% vs 14% | Every new install | ½–1 day | OTA |
| P5 | **No more endless spinners**: request timeout covers the body download; ~20 s cap across fallbacks; Retry buttons; refetch on foreground | 12 s timeout stops at headers, so a stalled body hangs forever; several screens have no Retry | Rare off-outage, constant during outages | ½ day | OTA |
| P6 | **White screen returning from a card page to the scanner** (opaque dark tabs background, no double freeze, defer refresh/camera restart until the transition ends) | Replay: 5–16 s blank on most back-taps for a heavy scanner | Heavy scanners | ½–1 day (*cause likely, not proven*) | OTA |
| P7 | **Clearer Change list**: group "same card, other sets", "same set", "Japanese version"; make the search icon work | Rows look identical; set/number are tiny; the search icon is decoration | Same users as P2 | 1 day | OTA |
| P8 | **Sign-in**: specific Apple "isn't set up on this iPhone" message + Google promoted after an Apple failure; email flow tells social users which button they used, and offers "Create account" for unknown emails | Apple fails on-device (ERR_REQUEST_UNKNOWN); 8 users / 60 days; email "doesn't exist" is mostly new users tapping Log In first | Small; recovery already 3/3 on 1.3.2 | ½–1 day | OTA + one Supabase SQL function |
| P9 | **Price display honesty**: label graded-fallback prices as "PSA 10 reference" in the price sheet; warn (or default cheaper) when the top match is a near-tie with a much cheaper card; show "…" not $0.00 while nothing is priced | Gardevoir $384 was a PSA 10 fallback shown as raw; gold vs common energy near-tie | 102 near-tie scans / 52 users; ~19 fallback scans | ½–1 day | OTA |
| P10 | **Collection performance** (memoized rows, FlashList, chart header split, expo-image) | Plain FlatList, unmemoized rows, SVG sparkline per row, whole inventory fetched twice | Large collections | 1–2 days | OTA |
| P11 | **Small**: Riftbound "not available yet" message shows on any server error (it works: 161 prod scans) → narrow it; vendor price-check mode + swipe-to-delete with undo; `.catch` on external links; people-search keeps punctuation | — | — | small each | OTA |

**Later / bigger (not this sprint):** collector-number tie-break between same-name candidates (biggest accuracy lever: the number differs in 59% of corrections; needs on-device text reading + native build + show-holdout gate); retrain the adapter with the 732 monthly corrections as hard negatives (time split, holdout excluded).

**Tested and rejected:** boosting sets picked earlier in the session (fixed 95, broke 595), boosting same-name in top 3 on small gaps (58 vs 171), flipping #1/#2 on small gaps (would break 907 correct picks).

**Not bugs:** "Open Settings" goes to Settings (code verified); black card art in replays is replay image masking; tray "TOTAL $0.00" was rows still matching; the "same card, two prices" cases were two different prints; People-search "no matches" was the Collection search box.

## Measurement
- Corrections: net corrected scans ÷ scans with a selection from `scan_events` (baseline 9.1%); PostHog `scan_match_corrected` overcounts (fires per pick, includes `switched_back`) and printing changes are untracked in the current build (P2 restores them).
- Activation: share of new installs that scan within the first session (baseline 44% ever).
- Any ranking change: show holdout top-1/5/10 must stay ≥ 79/91/92.

## Appendix: key references
- Placeholder guard: `backend/visual_index_placeholders.py:29-34` (`KNOWN_CARD_BACK_SHA256`), `backend/visual_index_incremental.py:574-603` (`append_missing_cards`), denylist `data/visual-index/placeholder_card_ids.json` (loaded once per process, `backend/raw_visual_index.py:69-87`), audit `tools/audit_placeholder_index_entries.py`. Affected ids: `me55-R`, `me55-G`, `me55-B`, `mep-120`, `tcgp-B4-`, `tcgp-B4b-`.
- ADD after sign-in: `scanner-screen.tsx:3677-3790` (handler, early return 3680), pill 907-920, guest gate 4493, tray drag gesture enabled only for non-guests 4383. `scan_add_tapped` is not emitted by current code.
- Tray row / Change sheet: `scanner-screen.tsx:836-869` (dropdowns), 3557-3612 (correction event + feedback), 4280-4289 (printing pick: no analytics); `change-card-picker.tsx:184-186` (raw order), 369-371 (dead search icon); `backend/catalog_tools.py:1708-1790` (printing priority, correct and deployed); `backend/server.py:2146,3286-3307` (2 cross-language tail candidates).
- Shutter: `scanner-screen.tsx:2994-3013`, `:1603-1609`; settle gate `raw-scanner-capture-surface.tsx:43,617-625`.
- Tooltip: `scanner-screen.tsx:~4983-4996`, `scanner-language-tooltip.tsx:96-113`; prompt `raw-scanner-capture-surface.tsx:292,314,369,790`.
- Timeouts: `packages/api-client/src/spotlight/repository.ts:9126-9131,9177`; `listExpansions` 8481-8488; `use-game-expansions.ts:39-66`.
- White screen: `app/_layout.tsx:85,94,197-199,209,405`; `providers/app-providers.tsx:488-501`.
- Sign-in: `features/auth/auth-service.ts:732-788,864-897,960`; `providers/auth-provider.tsx:289,354-365,1000-1036`; `login-screen.tsx:106,124-140`; `email_exists` in `supabase/migrations/20260806090000_social_10_public_users_mirror.sql`.
- Price sheet fallback: `scan-price-sheet.tsx:340-357`, `scanner-screen.tsx:5245-5253`, `repository.ts:2582` (`priceIsGradedReference`), `server.py:18262-18275`.
- Collection list: `portfolio-screen.tsx:1555-1641,2086-2163`; `card-list-row.tsx`; `price-sparkline.tsx:91`; `repository.ts:6258,696-701`.
- Events: `event-detail-screen.tsx:148-150,364`; `use-meta-feed-read.ts:29-95`.
