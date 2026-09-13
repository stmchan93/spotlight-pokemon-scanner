# Treasure Hunt scan API: meeting prep (2026-09-12)

Internal. Prepared for the Treasure conversation about using Ekalight's scanner as the identification API behind Treasure Hunt's "coming soon" card scan. Numbers trace to the working plan; sources are linked where external.

## TL;DR

- **What they want:** our scanner as the application programming interface (API) behind the "coming soon" camera feature in Treasure Hunt, at all their events. They tried CardSight.ai and found it "not good".
- **What we give:** identity only. One photo in, top-5 candidates out, keyed on TCGplayer product id (coverage per game still to confirm, see checklist), set code, collector number and printing, with a needs-review flag. No price, no name, no image. A binder-page mode returns up to 9 cards per photo.
- **What we get:** their Verified transaction feed: in-person sold prices per card, printing, condition, show and vendor. We know of no other source for this. Worth more to our pricing moat than any fee they can pay.
- **What we charge:** open at $300/month for all events, 10,000 identifications included, $0.02 each over. Fallback: $150/month minimum at $0.03. Floor: $99/month at $0.01, and only with the feed.
- **The two non-negotiables:** the transaction feed (fallback on form only: monthly export, trading card game (TCG) rows only, display rights) and the escape hatch: 30-day termination, key revocation, no non-compete.
- **The walk-away:** an attribution-only deal, or cash under $150/month base with no feed. Kill test after two shows: feed delivered plus a paid renewal or a second organizer, or we revoke the key.

## Verdict

Build it, small, as a data-for-scanner deal. Decline if the deal is attribution only. They have already designed their app around a scanner, and their own copy promises "exact printing", which CardSight does not return as a resolved answer (it offers parallel suggestions). They need identity, not price; their card page already shows TCGplayer and eBay pricing and their catalog is their own, so the integration is tiny and every rich feature stays inside Ekalight. Treasure Hunt is, feature for feature, the show marketplace in our own marketplace plan. Supplying them means choosing to be the picks-and-shovels TCG scanner for shows instead of building that marketplace. That fits the vendor-first finding. Choose it on purpose.

## What Treasure Hunt is and what it needs

Treasure runs a free card-show platform: ticketing for organizers, plus the Treasure Hunt app for attendees and vendors. Treasure earns ticketing fees (about $0.61 on a $10 ticket); the app is free to everyone. Attendees keep a wishlist and a collection, browse each event's vendors and booths, and send Card Requests during a "hunting window" that opens 10 days before the event. Vendors list inventory, get wishlist matches, answer requests with "Have it" or "Pass", and both sides record deals as receipts. A two-sided show marketplace.

**Where the scanner is "coming soon" (four places):**

- **Attendee wishlist add:** the add sheet already has Search and Scan tabs.
- **Request Card:** "Search for the card by name. (Scanning a card with the camera is coming soon.)"
- **Attendee collection add:** "Point your phone at a card and the app recognizes it automatically. Not live yet."
- **Vendor listing add:** "Tap the scan icon ... Review the matched result and confirm. Fill in listing details (grade, price, quantity)."

The scan screen itself reads: "Take a clear photo of the front of your card and we'll find its exact printing." One aimed still photo of one card: the well-framed case where a detector crop helped in our June experiment, not the tight binder case where it regressed.

**How vendors list today.** One card at a time: search by name, then grade or condition, quantity, cost basis, notes, For Sale toggle. Or import: "Upload a CSV or sync from DeckTradr" (CSV, a comma-separated values spreadsheet). Bulk listing is likely their pain point.

**Verified transactions.** Each side records its own receipt; transaction detail shows "whether just you, or both you and the vendor, have recorded the deal," and a deal recorded by both carries a Verified badge. A double-entry record of card, price, quantity, event, vendor and date.

**Catalog and grading.** Catalog tabs: Pokémon, One Piece, TCG, Sports. Wishlist entries and requests carry a grading preference of Any, Raw or Graded; the listing form takes a grading company from PSA (Professional Sports Authenticator) through TAG. PSA slab detection maps onto this later.

**They already have prices.** The card page shows "market pricing from TCGplayer and eBay." They need identity, not price.

## CardSight.ai: what they tried and why it likely lost

**What it is.** An API-first card identification service with a sports-first catalog; Pokémon, Magic and One Piece also covered. No Lorcana, Riftbound or Gundam.

**Response shape.** `POST /v1/identify/card` returns one detection per card with High, Medium or Low confidence and a list of suggestions. No price fields. `/v1/detect` only counts cards.

**Pricing.**

| Tier | Price | Included calls |
|---|---|---|
| Free | $0 | 750 |
| Pro | $14.95 | 5,000 |
| Premium | $74.95 | 30,000 |
| Ultra | $199.95 | 100,000 |
| Enterprise | custom | unlimited |
| Overage | $0.003 (Pro), $0.0025 (Premium), $0.002 (Ultra) per call; Free has no overage (hard cap) | |

**Their terms.** They train on customer data (§8(b)), provide the service "as is" with no uptime warranty (§11(b)), and bar customers from building competing products (§3(b)(ix)).

**Why it likely failed for Treasure.** No resolved printing (parallel suggestions only), a single coarse answer, and TCGs bolted onto a sports model. Ask them which.

**Sources:** [cardsight.ai](https://cardsight.ai/), [pricing](https://cardsight.ai/pricing), [terms](https://cardsight.ai/terms), [OpenAPI JSON](https://api.cardsight.ai/documentation/json).

## How we compete

Be honest about where they win, and do not fight there: breadth (14M cards, sports), latency (they claim "under 300 ms" against our roughly 1.2 s round trip), self-serve signup, five software development kits (SDKs), and price per call. A horizontal API always wins those. We win by being deep where the money is.

1. **Printing-level identity on TCGs.** Holo versus reverse versus promo stamp versus 1st edition is the difference between $5 and $500. We resolve printing, set badge, collector number and language; CardSight returns a card with parallel suggestions and a three-level confidence. Their guides ask for "exact printing"; that phrase is our pitch.
2. **Trained on the show domain.** Our adapter is trained and evaluated on real card-show captures: sleeves, glare, binder pages, phone cameras. Our hypothesis: generic models look great in a demo and fail at a booth. The show holdout is how we test it. Publish the show holdout as the benchmark.
3. **A shortlist, not a verdict.** Top-5 with a needs-review flag lets their app show a picker. One wrong answer with "High" confidence is worse than no answer for a vendor listing inventory. It also hides misses gracefully.
4. **Coverage they lack.** One Piece is shared; Lorcana, Riftbound and Gundam are ours alone; Japanese Pokémon works.
5. **More scan modes.** Binder page (9 cards a photo) for bulk listing, and a slab lane that reads cert and grade and prices the graded card. CardSight's `/detect` only counts cards.
6. **Terms.** No training on their images by default, no non-compete, retention off. Their terms do the opposite.
7. **Proof over claims.** Run both on 100-200 of Treasure's own photos and hand them the table. A 99.5% marketing number (CardSight's pricing page) loses to a side-by-side on the customer's data every time.
8. **A flywheel they cannot copy.** Every partner scan with a confirmed card (if rights are granted) and every verified transaction row feeds our labels and prices. Specialization compounds; breadth does not.

Positioning sentence: "CardSight identifies cards. Ekalight identifies the printing, on a phone photo at a show, and tells you when to double-check."

## Our offer

Three scan endpoints plus a usage endpoint, server to server, behind an API key (a secret token issued per partner), with a per-key rate limit and daily quota.

- **`POST /api/v1/partner/scan`:** one photo in; top-5 candidates out, each with TCGplayer product id, set code, collector number, printing, language, game and confidence, plus a needs-review flag. No price, no image link, no card name. They map the id onto their own catalog.
- **`POST /api/v1/partner/scan/page`:** one binder-page photo in; up to 9 identifications out. The vendor bulk-listing product on the same key; a page returning 9 cards counts as 9.
- **`POST /api/v1/partner/scan/{id}/feedback`:** the card their user actually confirmed. Recorded as that user's selection, never as a trusted training label.

Rules that go with it:

- **Training is off by default.** Partner scans stay out of training unless the term sheet grants it (fallback: labels only, images deleted after 14 days).
- **No accuracy claim before the benchmark.** See "The close" in the CardSight counter.
- **Sports stays theirs.** CardSight fits there. We pitch "the TCG scanner"; sports, if ever, is a separate deal.

## Money: what we charge and why

**The free-platform reality.** Treasure Hunt is free to organizers, vendors and attendees. Treasure's revenue is ticketing fees, roughly $0.61 on a $10 ticket. Any cash they pay us comes out of that margin, so it will be modest. Let the transaction data carry the rest of the value.

**The value framing (lead with this).** Their own Vendor Guide describes listing as a manual loop: tap add, search the catalog by name, then fill grade or condition, quantity, cost basis and notes. One card at a time, or a DeckTradr sync / CSV import. That is 30-45 seconds per card. A scan is about 3 seconds. A vendor listing 300 cards saves roughly 3 hours per show. On the attendee side, exact printings mean wishlist matches and "Have it" replies are right the first time.

**Unit of pricing.** We charge per identification, on usage across all their events, with a floor and a re-price. A binder-page photo that returns 9 cards counts as 9 identifications.

| | Base | Included | Overage | Notes |
|---|---|---|---|---|
| Opening (A) | $300/mo, all events | 10,000 IDs/mo | $0.02 | 12-mo term, first two shows free, binder-page included |
| Fallback (B) | $150/mo minimum | none | $0.03 | if they refuse a base fee |
| Floor | $99/mo minimum | none | $0.01 | AND the transaction feed, else decline |

- **90-day re-price clause.** Neither side knows real scans-per-event yet. After two or three shows have run, reset the rate and the minimum from actual usage.
- **Revenue share.** If Treasure ever charges vendors for a scanner tier, we take 20-30% of it.
- **Why they can afford it.** A 1,000-attendee show is about $600 of ticketing take to them. $300 a month across all events is small against a feature they have already promised in print.

## The CardSight counter

When they say "CardSight is $0.002 per call":

- **"You already rejected it."** CardSight is a sports catalog with TCGs attached. It returns one card with a High/Medium/Low label plus alternate and parallel suggestions; it does not resolve the exact printing. Their $0.002-0.003 overage buys that answer, and you found it "not good".
- **"We do what they don't."** We return the printing, cover Lorcana/Riftbound/Gundam/Japanese Pokémon, read binder pages, and our terms are the opposite of theirs (see "How we compete").
- **The close.** "Send us 100-200 of your real photos. We run both scanners side by side and hand you the table. If we do not beat CardSight on your photos, you owe nothing."

## In-room decision guide

- **If** they agree to the verified transaction feed **then** open at A ($300 base + $0.02 overage). Accept down to B ($150 minimum + $0.03). Never go below the floor.
- **If** they refuse the feed but offer real cash **then** hold at A. Walk if they will not clear $150/month base: that is 2× our committed server increment, and without the feed the deal has no other value.
- **If** they refuse the feed and want CardSight-level per-call pricing **then** decline politely. Offer the side-by-side benchmark as a free favor and leave the door open.
- **If** they want exclusivity **then** price it: A becomes $500 base, or a 12-month minimum commitment. Exclusivity is TCG-only.
- **If** they want sports too **then** that is a separate conversation. Not in this deal.
- **If** volume is unknown in either direction **then** insist on the 90-day re-price clause so neither side is stuck.
- **If** they ask for anything that is free for them to give (scan-first placement, the vendor email, named provider, the photo set) **then** take it in exchange for pilot leniency. Never trade it against base fee.

## Term sheet (ask → fallback)

In priority order.

1. **Verified transaction feed. Non-negotiable.** Ask: card (TCGplayer id), printing, condition/grade, price, quantity, event, date, region; delivered by API or weekly export; licensed to display in Ekalight and feed pricing. Fallback: monthly export, TCG rows only, display rights.
2. **Named exclusive TCG identification provider** for 12 months, sports excluded, on every scan surface with a link and in vendor onboarding. Fallback: named, non-exclusive, 6 months.
3. **Show-day placement.** Ekalight in the organizer's pre-show vendor email and on the check-in QR page. Fallback: one co-marketing post per show.
4. **Scan as the default tab** on vendor listing and attendee add; scanner mentioned in the vendor promo they already run.
5. **"Track this card in Ekalight" link** on transaction detail. Fallback: link on scan result only.
6. **200 of their real photos before launch**, with rights to publish the CardSight comparison. Fallback: 100 photos, private.
7. **Training rights** on scans and confirmed labels. Fallback: labels only, images deleted after 14 days.
8. **First look and 60-day right to match** on scanner expansions. Fallback: 30-day notice.
9. **Escape hatch. Non-negotiable.** 30-day termination, key revocation, no non-compete, and permission to sell our own vendor tools at their shows.

## Trades to have ready

- **Give** a lower base → **get** a 24-month term.
- **Give** a longer free pilot → **get** the feed starting day one.
- **Give** a waived quarter of overage → **get** scan-first placement and the vendor-email mention.
- **Give** sports later → **get** a separate price for it.

## Questions to ask in the room

1. How many events per month run on Treasure Hunt today, and how many vendors list per event?
2. Which surface calls the API first: vendor listing, attendee add, Request Card, or wishlist?
3. What did CardSight get wrong, specifically?
4. Can Verified transaction rows be shared, and in what form?
5. Do DeckTradr or CollectX identify cards themselves, and could their scans route to us?
6. Will they send 100-200 real photos this week?
7. What is the expected peak: scans per minute at their biggest show?

## What to leave the meeting with

- The photo set (or a date for it).
- The transaction-data answer.
- Event and vendor counts.
- A yes or no on a base fee.

## Our cost floor (why the numbers are what they are)

**The server decision.** To carry their bursts on the existing prod box, we are upgrading it to a t2d-standard-8. Incremental cost: +$75/month on a stacked 1-year commitment, or +$119/month on-demand until committed, plus about $5 per show-day when we burst to 16 for their biggest events. The base fee alone should cover that with margin: $300 is 4× the committed increment, $150 is 2×, and $99 is at cost. Never go below $150 base without the transaction feed. At the floor with no feed we are running a box for them at cost; that is the number to hold in the room.

**Per-scan compute is not the issue.** One identification costs about $0.0004 of compute, so even the floor rate of $0.01 is 25× cost. The fee is not about covering CPU. It is about the relationship having a price, and the base fee clearing the server increment however few scans they run in month one.

## Licensing constraints

We can hand Treasure a card's identity, not anyone else's data. Every licensed source has a redistribution clause.

- **Scrydex (§4).** No resell, sublicense or redistribution without written authorization; no benchmarking or dataset extraction. Card names, sets and images are Scrydex catalog data, so even an identity response is affected. Keying the response on TCGplayer product id + set code + collector number (`cards.tcgplayer_id`, `card_tcgplayer_products`) and omitting names and images shrinks the exposure to near zero. We still ask, in the Scrydex email.
- **PokemonPriceTracker (PPT, §6).** Caching and serving to our own app's users is fine on Business or Enterprise. Redistribution as a data service is forbidden on every plan. No PPT-derived number ever goes to a partner. Moot here: we return no price.
- **PriceCharting.** No redistribution.
- **TCGplayer via TCGCSV.** Unverified; irrelevant if we return no price.

**Decision:** the partner gets identity only. Recent solds, graded comps and pop reports stay in Ekalight.

**Add to `docs/legal/README.md`:** (1) Scrydex written authorization for third-party identity; (2) PPT plan tier for commercial in-app use.

## What this costs us beyond the build

The only cost that moves with volume is CPU (central processing unit), and the total is small. Peaks during their shows are what matter, and that is a known, cheap lever. Everything else is pennies, time, or a one-time legal item.

**CPU reality check.** One scan is about 1.2 vCPU-seconds (virtual CPU). 30 events a month × 3,000 scans = 90,000 scans = ~30 vCPU-hours a month, about 4% of one core. Totals will not "skyrocket" the box.

| Item | Cost | Notes |
|---|---|---|
| Option 2: dedicated partner VM (virtual machine) (t2d-standard-4, `SPOTLIGHT_PARTNER_ONLY=1`) | ~$120/mo on-demand, ~$75/mo with 1-yr CUD (committed use discount); +$8 disk, +$3 IP | Their bursts never touch app users. Only when the split triggers fire (see "Existing prod box, not a new one" below). |
| Card detector inference | +50-150 ms CPU per partner scan | No fee. **Licence gotcha:** Ultralytics YOLOv8/YOLO11 is AGPL-3.0; a commercial API needs an Ultralytics Enterprise licence. Use Apache-2.0 (YOLOX, RF-DETR, or the classical computer-vision (CV) quad finder). Training: a few dollars of GPU. |
| Server OCR (optical character recognition), slab lane, later | RapidOCR: CPU only, +200-500 ms on the slab route. Google Vision: $1.50 per 1k images | 10k slab scans/month via Vision ≈ $15. Not in the pilot. |
| Scrydex credits | $0 | Identify does not call Scrydex; we return no price. Authorization may come with a plan condition; unknown until asked. |
| Partner image retention (if consented, 14 days) | pennies | 3,000 scans × ~200 KB ≈ 600 MB per show in GCS (Google Cloud Storage); lifecycle rule deletes. |
| Database growth | disk only, but real | `scan_events` keeps full request+response JSON and 30 candidate rows per scan: 90k scans/month ≈ 2.7M rows, ~1-2 GB/month. Log partner scans lean (top-5, no debug payload) or the card-page (PDP) cold-read problem returns. Prod has disk headroom; staging does not. |
| Network egress | negligible | Images come in free; responses ~2 KB. |
| Cloud Logging | small, usage-billed | Info level only; debug off. |
| Status page / uptime check | $0 | UptimeRobot-class free tier on `/health`. |
| Hosted web scanner page (optional) | ~$0 hosting; a domain ~$12/yr | Static page; needs CORS (cross-origin resource sharing) on the partner route. |
| Legal | one-time | Contract review; Scrydex authorization. |
| Ops time | the real cost | Someone reachable during their shows; a partner-key load test before each big one. "Best effort, no SLA (service level agreement)" in the pilot. |

**Rule of thumb:** the pilot runs on the existing box; "every show" is a ~$75-120/month upgrade to that same box.

## Server cost model

**Today.** Prod is one GCP (Google Cloud Platform) VM, `t2d-standard-4` (4 dedicated AMD cores, 16 GB) in us-central1-c: ~$119/month on-demand, ~$75 on a 1-year commitment. Plus a 175 GB disk (~$17/mo), static IP (~$3), daily snapshots (~$2-3), GCS buckets (<$1). Staging is a committed `e2-standard-2` (~$31). Total ≈ $175/month on-demand pricing (≈ $130 with the existing commitment), plus ~$200/month Scrydex.

**What one scan costs the box.** The encoder (SigLIP2, ONNX, CPU) is ~70 ms; the whole request (decode, encode, search over ~46k cards, rerank, pricing lookup, logging) is ~1.2 vCPU-seconds. One Python process caps inference at vCPUs minus 1 slots (3 on prod) and queues up to 6 s before shedding a 503. At ~0.85 scans/s per slot, prod does ~2.5 scans/s sustained (~150/min, ~9,000/hour) under a 3 s 95th-percentile latency (p95) with ~10-12 people scanning at once. RAM (model 3.5 GB + DB cache in 16 GB) and disk are not constraints. **CPU concurrency is the only constraint, and it scales linearly with cores.** Treasure adds peaks, not totals.

| Scenario | Their load | What breaks | Fix | Extra $/month |
|---|---|---|---|---|
| **Pilot** (2 shows/mo, ~3k scans/show, ≤10 concurrent) | 6k scans/mo | Nothing, unless their show lands on one of ours | Prod behind a per-key rate limit. Optional resize to t2d-16 for their show day (~$0.33/hr from 8 cores, 12 h ≈ $4-8) | **$0-20** |
| **Every show** (30 events/mo, ~90k scans, 10-20 concurrent, weekend overlap with ours) | 90k scans/mo | Prod's 3 slots: their burst queues our users; 503s at ~20+ concurrent | Decided: upgrade prod to `t2d-standard-8` (below): 7 slots, ~6 scans/s, +$119/mo on-demand, sharing slots. Later split option: dedicated `t2d-standard-4` (`SPOTLIGHT_PARTNER_ONLY=1`, slim ~3 GB catalog, own scan log): $119 + $8 disk + $3 IP + $2 snapshot | **+$75-90 (CUD) to +$119-132 (on-demand)** |
| **Scale** (100+ events/mo, 300k+ scans, 30-40 concurrent) | 300k+/mo | The 4-core box, then the architecture: SQLite is single-writer, so a second box cannot share the log DB | `t2d-standard-16` partner box (~$478 on-demand, ~$300 CUD), or 2× t2d-8 behind a load balancer (+$18/mo) with scan logs on Postgres/Cloud SQL (~$50-100/mo) | **+$300-500, plus a DB change** |

RAM, disk (lean partner logs ≈ 200 MB/month), network and the Scrydex plan need no upgrade in any scenario. The detector adds ~10% CPU per partner scan; slab OCR ~30% on that route only.

**Founder's decision (2026-09-12): resize prod to `t2d-standard-8` and stack a 1-year commitment.**

- **How commitments stack.** A GCP commitment is a billing floor on resources in a region for a machine family, not a lock on a machine. Our existing 1-year t2d commitment (4 vCPU + 16 GB, since 2026-07-21, ~$75/mo) keeps covering the first 4 vCPU/16 GB after the resize. The extra 4 vCPU/16 GB bills on-demand (~$119/mo) until we stack a second 1-year commitment for that delta (~$75/mo). Commitments stack; they never convert or extend. Prod compute then ≈ $150/mo committed (vs $194 mixed). Purchase: the same two quota steps as last time (COMMITMENTS, then COMMITTED_T2D_CPUS), starts next midnight PT, ~37% off.
- **Why not 16.** The delta is 12 vCPU/48 GB: +$225/mo committed or +$357 on-demand, total ≈ $300/mo, 3× the 8.
- **Burst pattern.** Resizing is free and reversible; the committed portion applies at any size. Keep 8 as the baseline, burst to 16 on known big show days: extra 8 vCPU on-demand ≈ $0.33/hr, so a 12-hour show day ≈ $4-8. Reserve a day ahead.
- **What 8 cores buys.** 7 inference slots, ~6 scans/s, ~20-25 concurrent scanners at a 3 s p95. Covers "every show" on one box with our users on it, and doubles headroom for our own shows, so part of the cost is ours regardless.
- **What it does not fix.** Bursts still share slots (mitigated by a partner slot cap); still SQLite on one box, so the Scale DB change stays ahead at 300k+/month.
- **Cost floor and pricing rule:** see "Our cost floor" above.

**Existing prod box, not a new one.** Current app load leaves headroom on prod, so partner traffic costs nothing beyond the resize: no second deploy target, logs in one place. Guard with the per-key rate limit and partner slot cap. A dedicated `t2d-standard-4` (same code, `SPOTLIGHT_PARTNER_ONLY=1`, slim catalog copy, own log, ~$75-90/mo committed) comes only when our own users grow or **two or more of these hold for a month**:

- partner scans exceed ~50k/month;
- their show days overlap ours;
- p95 on our own scans rises above 3 s during their events;
- partner `scan_events` growth exceeds ~500 MB/month.

Waiting to split costs zero. Never: two boxes on one SQLite file, or partner traffic on staging.

## Server-side OCR: not in the pilot

1. **Raw identification: no, never.** Identification is visual (SigLIP2 → index search → rerank); no text is read. The only OCR in the raw lane is an optional on-device collector-number tiebreak, which the partner route skips. Server OCR here would add 200-500 ms and could only hurt by injecting a wrong number. The API's raw accuracy is exactly the visual matcher's accuracy on the partner's crop.
2. **Slab lane: only if Treasure asks, behind `lane=slab`.** A PSA slab is identified by its label, so without the phone's ML Kit the server must read it. Risk is bounded: cert numbers are clean print on a white label, and `slab_cert_resolver` validates certs against the catalog and falls back to label text + visual match, so a bad read degrades to "needs review", not a wrong card. +200-500 ms on slab requests only. Measure on our PSA holdout first.
3. **Offline auto-labeling: yes, as a separate project, never in a request.** A nightly, niced batch job proposes labels from stored show captures for the retrain gate that is blocked on fresh show labels. OCR proposes, the catalog validates, a human accepts.

**Net:** the pilot is detector crop + the existing visual matcher. Nothing slower for raw cards than the app path minus the phone-side crop.

## Figure out on our side before the meeting

- **Send the Scrydex authorization email** with the third-party identity question added.
- **Confirm TCGplayer product ids exist** for the rows we would return: `cards.tcgplayer_id` coverage per game.
- **Benchmark tool ready** (`tools/eval_partner_uncropped.py`) the minute their photos arrive.
- **Know our show holdout numbers** (from `docs/show-benchmark-true-baseline-2026-08-30.md`, not this plan): 79% top-1 / 91% top-5 / 92% top-10 with reticle crops. Do not quote them as the API's accuracy; uncropped photos are unmeasured.
- **Decide per-key rate limit and daily quota defaults.**
- **API-key CLI (command-line tool) and a sandbox key ready** (`backend/tools/partner_keys.py`).
- **Decide the free-pilot cap.** Our proposed cap: two shows or 5,000 scans, whichever first.
- **Branch status:** built on `partner-api`, inert behind `SPOTLIGHT_PARTNER_API_ENABLED` (default off), not deployed.
- **Who is on call** for their first show.

## Technical appendix

**What has to move from the phone to the server**

| On the phone today | Server needs | Size |
|---|---|---|
| Reticle crop → 630×880 (`scanner-normalized-target.ts`) | Card detector + perspective warp (reuse `synthetic_capture.py` math); partner routes only | 4-8 evenings incl. benchmark |
| PSA label OCR (ML Kit), collector-number OCR | Server OCR (RapidOCR or Vision); raw lane works without it; slab lane needs it; later | 4-6 evenings |
| Lane / game / language toggles | Accept hints; auto-detect lane via the existing raw/slab classifier | 1 evening |
| App orchestrates visual-match → rerank → paging | One synchronous call under one inference slot; top-5 back | 1 evening |
| Focus/lens/retry in the camera | Server checks: resolution, blur, card-too-small → `messages[]` + `needsReview` | 1 evening |
| 3×3 grid the user aligns (binder) | Detector boxes → N crops → `visual_match_scan_batch` | 1 evening |

The in-app scanner's request path is untouched; the only shared resource is inference slots.

**Phases and effort**

| Phase | Scope | Effort |
|---|---|---|
| Accuracy gate (first) | Detector + warp; `tools/eval_partner_uncropped.py`: resize-only vs center-crop vs detector; side-by-side with CardSight | 4-8 evenings |
| Pilot | API-key auth, `/api/v1/partner/scan`, `/api/v1/partner/scan/page`, feedback, rate limit + quota, usage counter, `training_eligible`, lean logging, `docs/partner-scan-api.md` | 8-12 evenings |
| Every-show hardening | Metering export, key rotation, dedicated box or scheduled resize, error contract, idempotency, 14-day retention, uptime check | 8-12 evenings |
| Slab lane | Server OCR feeding `slab_cert_resolver` | 4-6 evenings |
| Hosted web scanner page (optional) | Browser camera + reticle → same API; our own no-install attendee funnel | 8-15 evenings |
| Native SDK | Not recommended | 40-80 evenings |

**What we will implement** (approved 2026-09-12; ≈ 12-18 evenings; order 1 and 4 → 2 → 3 → 5 → 6)

1. **Partner identity and keys (2-3 evenings).**
   - Tables `partner_accounts`, `partner_api_keys` (hashed), `partner_usage_daily`; `X-API-Key` auth beside the Supabase JWT (JSON Web Token) path in `request_auth.py`; CLI `backend/tools/partner_keys.py` (create, rotate, revoke).
   - Per-key token bucket → 429 with `Retry-After`; daily quota → `quota_exceeded`; partner slot cap (default 2 of 7 on t2d-8).
2. **Image normalization (4-8 evenings, includes benchmark).**
   - `_partner_normalize_image`: EXIF-rotate, find the card (Apache-licensed detector, classical-CV quad finder fallback), warp to 630×880; `SPOTLIGHT_PARTNER_CROP_MODE=center|detector`; quality checks → `messages[]` and `needsReview=true`.
   - `tools/eval_partner_uncropped.py` is the gate before any accuracy claim.
3. **Three partner routes (3-4 evenings).**
   - `POST /api/v1/partner/scan` (image ≤8 MB + hints) → top-5 `{tcgplayerProductId, setCode, number, printing, language, game, confidence}` + `needsReview` + `scanId`; no price, image URL or name. `/scan/page` (up to 9 crops); `/scan/{scanId}/feedback` writes `selected_card_id`, never `confirmed_card_id`; `GET /api/v1/partner/usage`.
   - Error contract `{error, code, retryAfterSec?}`; `clientScanId` idempotency returns the stored response.
4. **Data hygiene (1-2 evenings).**
   - `scan_events` gains `partner_id`, `api_key_id`, `client_scan_id`, `training_eligible` (partner rows 0 unless granted); lean logging.
   - Artifact upload skipped unless `retain_artifacts` (then a `partner/` prefix, 14-day lifecycle); export scripts filter on `training_eligible`; review UI hides partner scans.
5. **Ops and docs (1-2 evenings).**
   - `SPOTLIGHT_PARTNER_API_ENABLED` gates every route; `docs/partner-scan-api.md` with curl and Postman; structured log line; uptime check on `/health`.
   - Partner-key load test (pass = p95 < 3 s, 503 < 1%, app scans unaffected); `backend/tests/test_partner_api.py` in `run_all_tests.sh`.
6. **Infrastructure.** The founder's own task: resize to t2d-standard-8 (reserve-then-flip, ~2 min downtime), stack the commitment, show-day runbook for bursting to 16.

**Not in this build:** server OCR, slab lane, hosted web scanner page, CORS, metering dashboards, dedicated partner box, native SDK.

**Built without shipping.** The `partner-api` branch lives in its own worktree (`../spotlight-partner-api`) so nothing rides along in an OTA (over-the-air update, which bundles the checked-out tree). Every route sits behind `SPOTLIGHT_PARTNER_API_ENABLED` (default off) plus a key row; merged code is inert on staging and prod until both exist. Testing is local against a restored staging DB (`tools/restore_staging_db_local.sh`) with curl. No deploy, no OTA, no VM env change. Kill switch: revoke the key, or flip the env flag off.
