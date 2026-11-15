# Booth Posts: vendors advertise their booth on the show map

Date: 2026-10-29
Status: SPEC, not built
Target: live on production by ~Nov 29 for the Dec 13 show (organizer/vendor email goes out ~Dec 6)

## Why

- Hawaii show (Oct 24-25, first weekend the Events tab was tracked): 104 of 369 active prod users opened the Events tab, 84 opened the show page, and 54 of the 104 came back 4+ times. 67 of them never scanned, so they are attendees. The map has a real audience on show weekends; between shows it is ~6 people a day.
- One vendor posted unprompted, and the post got zero engagement. Cause: posts and show vendors are not connected. A vendor on the map is just a name, tables, tags, Instagram and logo, and the post went into the general feed, not anywhere an attendee browsing the map would see it.
- The fix is to put vendor posts where attendees already are (the map), and to give vendors a reason to post (live numbers and booth stats).

## Decisions (locked 2026-10-29)

- **No verification.** Claiming a booth is instant. One claim per booth; "Not you? Report" on claimed booths; admin can unclaim.
- **Photos and captions only, no video.** Posts already support multiple photos plus text with image moderation. Video is out for Dec 13: Supabase egress on the free prod plan, the moderator is image-only, show wifi, likely native build. Revisit with Mux / Cloudflare Stream only if vendors ask.
- **No paid or featured placement.** Not until there is proof.
- **Booth stats are private** to the vendor and admin. No public "most viewed booth" ranking.
- **No QR signs.** Attendees download the app at the show entrance; vendors don't hand out QR codes.

## What we have vs what we need

| Piece | Have | Need |
|---|---|---|
| Show map with vendors, search, chips, vendor card | Yes (Events tab) | Claim button, posts strip, Message/Follow on the card, posted-today dot on pins |
| Posts with multiple photos, captions, moderation, likes, comments, DMs, follows | Yes (Supabase) | A post can be tagged to a show booth |
| Vendor ↔ account link | **No** | Booth claims table + claim flow |
| Booth view counts | **No** (PostHog only sees screen names) | Booth view events the vendor can read back |
| Live "N browsing" count | **No** | Presence heartbeat + count |
| Admin | `/admin/events` edits shows | Claims list (unclaim), show-day numbers |

## The experience

### Vendor (example: Island Slabs, table C4)

**About a week before**
1. Gets the vendor email: "You're on the Ekalight floor map. Claim your booth and post your case." It has a link and a screenshot of a real booth post.
2. The link opens the show map with their vendor selected. The card has a new **This is my booth** button.
3. Taps it and signs in if needed. **Claimed immediately.** The card now shows their @handle and a **Message** button. If someone else already claimed it: "Already claimed · Not you? Report."

**Setup morning**
4. Opens the app to scan, as vendors do. A banner shows on the scanner: **"Doors open in 1h · 41 people are browsing the map. Post your booth →"**
5. Taps it and the post composer opens. They take 2-3 photos of the case and write a caption. **Show on my booth at [show]** is on by default for claimed vendors during the show window.
6. After moderation (about 2 min) the post shows on their map card, on the show page's "From the floor" row, and in the regular feed. Their pin gets a dot.

**During the show**
8. Sees **"Your booth today: 63 views · 14 Instagram taps · 3 messages"**, updating live (on their profile and as a pill on the show page).
9. Attendees message them from the card, using the existing DMs.
10. Can post again any time; the dot refreshes.

**After the show**
11. Recap notification: "Island Slabs at [show]: 148 booth views, 37 Instagram taps, 9 messages, posts seen 212 times."
12. Booth posts leave the map when the show ends but stay on their profile. The claim carries over to the next show with the same vendor.

### Attendee

**Before the show**
1. Opens the show page and sees a **From the floor** row of booth-post photo cards ("Island Slabs · C4 · 2h ago").
2. On the map, dotted pins have posted. Tapping one shows the card with a photo strip, **Message**, **Follow**, and Instagram.
3. Following a vendor puts their posts in the attendee's feed.

**At the show**
4. Checks "From the floor" through the day for new posts.

### Admin (you)

- `/admin/events` → **Booths** per show: claimed by whom, when, with **Unclaim**, and any reports.
- **Show-day numbers**: browsing now, vendors claimed/posted, top booths by views. This is the pitch material for organizers and future vendor tiers.

## Build order

1. **Booth claim.** Claims table, claim button, unclaim in admin. Unblocks everything else.
2. **Booth posts.** "Show on my booth" toggle, posts on the card, "From the floor" row, pin dot, Message/Follow on the card.
3. **Booth stats.** View/Instagram-tap/message counts, live pill, post-show recap.
4. **Live browsing banner.** Presence heartbeat; banner on the scanner and show page during the show window.
Items 1-3 are the core; cut 4 if time runs out. Everything ships as OTA + Supabase migrations + a backend deploy; no native build.

Milestones: claim + posts on staging by ~Nov 12; stats + banner by ~Nov 19; admin by ~Nov 24; production by ~Nov 29 (needs explicit approval per AGENTS.md); vendor email ~Dec 6.

## Success measures (Dec 13)

- Vendors who claimed / vendors on the map (goal: 25%+)
- Vendors who posted at least once (goal: 15+)
- Attendees who opened a booth card with posts; messages started from a card
- Vendors who open their stats more than once (are the numbers the hook?)

## Risks

- **A wrong claim.** Instant claim means someone could grab another booth. Mitigation: report + admin unclaim; this is a local show where vendors know each other.
- **Moderation delay.** Photos are hidden until the worker approves them (cron every 2 min). Acceptable; the composer should say "Your post will appear on your booth in a couple of minutes."
- **Egress on free Supabase.** Booth photos are served on every card open. Serve thumbnails on the card and full size only on tap. Watch egress on show day.
- **Vendors don't post.** Mitigated by the walk-the-floor setup hour, the organizer email, and the live banner. The claim + stats are still useful even without posts.

---

## Appendix: technical notes

### Where things live

- Show and map data: backend, `backend/spotlight_events.py`, `backend/data/spotlight_event_maps/<eventId>.json`. Vendor `id` is a stable slug (`3vilcollections`, `808-cardtel`); the client type is `SpotlightEventMapVendor` in `packages/api-client/src/spotlight/spotlight-events.ts`.
- Social: Supabase Postgres, client-direct with RLS. `posts` and `post_media` in `apps/spotlight-rn/supabase/migrations/20260720090100_social_01_posts_comments_reactions.sql`; `createPost` in `apps/spotlight-rn/src/features/social/social-service.ts`.
- Per the split principle (durable user truth goes in Postgres), claims, booth tags on posts, view events and presence all go in **Supabase**, not the SQLite backend. The backend keeps owning the vendor list.

### New Supabase objects (one migration, `social_27_booth_posts`)

- `booth_claims (vendor_id text, user_id uuid, event_id text, claimed_at, revoked_at)`, unique on `vendor_id` where `revoked_at is null`. Keyed by vendor slug (not per show) so the claim carries to the next show. RLS: insert own row only; read all; revoke = admin only (`user_profiles.admin_enabled`).
- `booth_reports (vendor_id, reporter_id, created_at)`, insert-only for users.
- `posts.event_id text null`, `posts.booth_vendor_id text null`. Trigger: `booth_vendor_id` may only be set when the author holds the active claim for it. Index `(event_id, created_at desc)` where `event_id is not null`.
- `booth_events (event_id, vendor_id, viewer_id, kind, created_at)`, with `kind` one of `card_open | instagram_tap | message_start | post_view`. Insert by any authenticated user (guests are anonymous Supabase users). Rate-limited in a trigger (dedupe the same viewer + vendor + kind within 10 min). Read only through an RPC `booth_stats(vendor_id, event_id)` that requires the caller to hold the claim (or be admin) and returns counts plus distinct viewers.
- `event_presence (event_id, user_id, last_seen)`, upsert on show page/map open and every 60s while focused. RPC `event_browsing_now(event_id)` = distinct users with `last_seen > now() - 15 min`. Chosen over Realtime Presence to stay clear of free-plan concurrent-connection limits.
- Same counter/moderation rules as social_20: anything counted must go through `is_counted_content`.

### RN changes

- `event-vendors-section.tsx` vendor card: claim button / "Already claimed · Report", photo strip, Message (existing DM entry), Follow (existing follows).
- Floor map pin dot: from a single query of today's booth posts for the event, keyed by `booth_vendor_id`.
- `event-detail-screen.tsx`: "From the floor" row; vendor's own stats pill; browsing-now count.
- `new-post.tsx`: "Show on my booth at [show]" toggle, visible only to claimers during the show window (show dates from the event, ± 1 day before); passes `event_id` + `booth_vendor_id` to `createPost`.
- Scanner banner: show-window + scanned-today + not-yet-posted-today; dismissible.
- Fire `booth_events` on card open, Instagram tap, Message tap, and post view in the strip.
- Deep link `spotlight://events/<eventId>?vendor=<vendorId>` selects the vendor on open (check the existing `[eventId].tsx` route params).
- PostHog: mirror `booth_claimed`, `booth_post_created`, `booth_card_opened`, `booth_stats_viewed`.

### Backend changes

- `/admin/events`: Booths tab (claims, reports, unclaim via the service role), show-day numbers.
- Post-show recap: a scheduled job the day after each show inserts one notification per claimer with their `booth_stats` totals (existing `notifications` table).

### One-tap claim + live heat (`social_29_booth_match_heat`, 2026-10-31)

- List-first claiming: "This is you" pinned card when the signed-in email matches the vendor's Treasure email; "Are you a vendor? Find your booth" turns on Claim pills per unclaimed row (Done exits); your own row shows "Your booth" + Post. The card's "This is my booth" stays as a de-emphasized fallback.
- Emails never leave the builder machine in plaintext: `tools/build_event_floor_map.py --vendors-csv` writes a gitignored sidecar `<eventId>.vendor-emails.json` (vendor id -> sha256 of lowercased trimmed email, PAID/MIXED rows only). `tools/sync_vendor_email_hashes.py --event-id X --env staging [--dry-run]` replaces that show's rows in `booth_vendor_emails` via the service-role-only `replace_booth_vendor_emails` RPC. The table has RLS on and no policies; `suggest_my_booth(event_id)` compares against the caller's own JWT email and returns vendor ids only. The backend never serves the sidecar.
- Heat: `event_hot_booths(event_id)` = up to 10 vendor ids with card opens from >= 3 distinct people in the last 30 minutes, no counts. Row flame + table glow (vendors-only shows: row only), refreshed every 60s while the show page is focused.
- No Instagram match: neither `user_profiles` nor `public_profiles` stores an Instagram handle.

### Open questions

- Is the vendor email sent by you (Spotlight shows) or a third-party organizer? This affects wording and who owns the vendor list.
- Push vs in-app for the recap: in-app notification is certain; push depends on the current notification setup.
- Should the claim also carry across organizers if the same vendor slug shows up at another organizer's show? Default: yes (slug-keyed).
