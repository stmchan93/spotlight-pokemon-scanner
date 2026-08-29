# The Listing Feed — Concept Doc (2026-08-28)

Buy / sell / trade posts with Instagram energy, backed by structured market data.
Brainstormed 2026-08-28; this doc is the durable record of the vision, the object
model, every decided design point, and the deliberately-open questions. No code
was written; nothing here is scheduled.

---

## 1. The problem, grounded in real behavior

A friend of the founder (an active seller, @sky.collectibless-style account) runs
his card business on Instagram stories: photos of slab stacks with "SOLD OUT"
stickers, a slab held up with text bubbles — *"Anyone else have secret PSA 10
megas? I want all PSA 10s 2011–2016 dm me"* — showcase posts that advertise that
he "sells heat." Shops do the same with designed flyers (real example: Main St.
Cards' buyback-rates graphic — "85% on Pokémon PSA 7+ $0–70…", a date window, a
consignment note).

This ritual works socially but fails structurally:

- **Reach is capped at followers.** A sale only happens if the buyer already
  follows the seller. Hunting a card means hoping the right account posts it.
- **Nothing is searchable.** An untagged photo is invisible; stories die in 24h.
- **Wants evaporate.** "I want all PSA 10 megas" matches nothing and expires.
- **Claims are chaos.** Comment-race "claim sales" cause disputes.
- **Trust is vibes.** High scam likelihood; no track record beyond screenshots.

The product thesis: **keep the theater, add the market underneath.**

> On Instagram, your post reaches your followers.
> Here, your post reaches everyone who wants what's in it.

Posts get indexed by **cards** (the card graph), not just by people (the follower
graph). Distribution stops depending on audience size.

## 2. The one law (governs every design decision)

**The user does IG-level effort, ever. All structure is inferred. All correction
is lazy.**

- No post-type pickers, no listing forms, no filter builders, no confirmation
  dialogs. You post a photo/video and maybe a caption — that is the entire
  required interaction.
- The system derives everything: which cards are in the media, what the text
  means, whether it's a sale/want/flex, what the prices are.
- When inference is wrong, correction happens at the moment the wrongness
  surfaces (a mis-aimed ping carries "not what you're after? tune/mute"; a wrong
  tag is editable on the post) — never as an up-front gate.

## 3. Object model — one post type, cards carry the commerce

There are **no post types**. A post is `media + text + tagged cards`. Each tagged
card may optionally carry:

- an **asking price** → that card is for sale in this post
- a **want flag / want criteria** → the poster is looking for it
- nothing → it's being shown off

The post's apparent "type" (sale post, buy list, trade binder, showcase) is
**derived from its attachments**, never declared. One post can mix all three —
the friend's Lucario story is literally a showcase (the tagged slab) plus a
category want ("all PSA 10 megas 2011–2016") in one frame. Real behavior refuses
taxonomy; the model shouldn't impose one.

Derived rows (the fuel for everything downstream):
- `post_cards`: (post, card id, asking_price?, want?) — from vision + text
- `post_wants`: (post, criteria: grader/grade/years/category/game/price bounds,
  optionally percent-of-market payout for shop buylists)
- post-level derived intent for badges/filters

These rows power, in order: search indexing, the matcher, feed ranking
("has a card you want"), rendering (price stickers, "looking for" badges), and
eventually reputation (sold marks).

## 4. Inference pipeline

### 4a. Vision: media → card identities
- **Slabs first.** The friend's content is mostly PSA slabs, and slabs are the
  most machine-readable objects in the hobby — the existing slab lane already
  reads PSA labels (cert number → exact card + grade + that physical copy).
  Near-perfect tagging for the dominant content type on day one.
- **Raw multi-card detection later.** The scanner's ruled-out YOLO experiment
  does NOT preclude this: that ruling was about live-scanner UX (the reticle
  encodes intent). An uploaded binder photo has no reticle — detector → crop →
  match-each is the right tool there, run async.
- **Video** = the same pipeline on sampled frames, deduped by card id. (Open
  question: v1 or later — see §11.)
- Tags attach **silently** (no "confirm these 8 cards" sheet); editable on the
  post afterward.

### 4b. Text: captions + on-media text → intents, prices, wants
Two tiers, one closed schema:
1. **Deterministic hobby-grammar parser** (high precision, instant): WTB/WTS/NFS,
   "paying X", "$40 shipped", PSA/BGS/CGC + grades, year ranges, set/rarity
   names resolved through the EXISTING search alias tables.
2. **Small LLM call** (haiku-class, fractions of a cent per post) for mushy
   phrasing — its output passes the same validators.

**The hallucination cage:** the parser can only emit values that validate
against the catalog (real graders, grades 1–10, real sets/rarity buckets, sane
years/prices). Invalid values are dropped, never guessed.

**Cross-signal agreement:** text and vision check each other ("PSA 10 megas" in
the caption + tagged PSA-10 mega slabs → confidence up; "$85" with exactly one
tagged card → safe price attachment).

### 4c. Confidence buys behavior (the crux, given no confirmations)
- **High** → full behavior: standing want, pings, price stickers.
- **Medium** → indexed for search only; nobody gets pinged.
- **Low** → it's just a post.
A silent system must err silent: the failure mode is always "the magic quietly
didn't happen" (indistinguishable from IG), never wrong notifications.

### 4d. Quality program
- **Shadow mode first** (the TCGCSV playbook): parser runs on every real post,
  logs what it WOULD do, pings no one; read logs, tune, then enable.
- **Golden test set** seeded from real IG posts — the four screenshots from this
  session are fixtures #1–4.
- **Feedback flywheel:** every tune/mute/tag-edit is labeled training data;
  **ping-mute rate is the live quality metric**. Tag confirmations quietly
  produce labeled data for the vision model too.

## 5. Demand is one schema with three doors

The wishlist, caption-derived standing wants, and the search bar are the SAME
object — demand — expressed three ways, parsed into one schema, matched against
one pool of supply:

- **Wishlist** = wants you pick (card-level; already exists).
- **Standing wants** = wants you describe ("all PSA 10 megas 2011–2016") — a
  saved search created silently from a post's text; lives as long as the post;
  hunts continuously. No filter UI ever — the sentence is the interface.
- **Search bar** = wants you type right now. Queries run through the same
  parser: "buying charizard" → intent(buying) + card(charizard) over the post
  rows; "selling psa 10" → priced PSA-10 posts; "moonbreon under 2000" → parsed
  price bound. Photo-only posts with no caption still match (vision tagged
  them). A repeated search is itself a demand signal ("get alerts for this" is
  free machinery).

## 6. Matching + privacy-preserving pings

A batch matcher (the tabled market-signals spec is its blueprint, including the
push milestone) joins new supply against all demand and vice versa:

- Supply appears (a priced card is posted) → ping wishlist holders + matching
  standing wants: "a card you want was just listed, $X (market $Y)."
- Demand appears (a buy post / buylist) → ping OWNERS: "someone's paying for a
  card you have."

**The match always notifies the private party, never exposes them.** Wishlists
and collections are private (per the shipped privacy policy). A buyer never sees
who owns what; owners get the quiet ping and reveal themselves only by replying.
Demand is public (it's a post); supply stays private until the owner opts in by
acting. This respects the existing privacy posture AND is better product ("3
sellers slid into your DMs" beats a directory).

## 7. Card-show semantics, not auction semantics

- **Fixed asking prices**, prefilled/tracked against live market (we price every
  card); "or best offer" culture lives in DMs.
- **No auctions, no bids, no timers, no escrow.** Explicit user preference:
  "traditional sense of buying/selling like they do at card shows."
- **No exclusive claims.** Multiple people can tap "Interested" on the same
  card → parallel DM threads with the card pinned; the seller talks to
  everyone, like a show table. On sale, other threads get a gentle "this one's
  gone."
- **Deals close in DMs** (existing DM system + shared-post bubbles). Payment is
  external and between the parties — the app never touches money (v1..n).

## 8. Sold is a résumé, not just a state

- Marking sold slaps the **"SOLD" sticker** on the card in the post — the exact
  visual ritual the community already speaks (see screenshots). Sold posts are
  advertising: "this guy sells heat."
- **Feed expiry ≠ deletion.** Listings auto-expire from the feed (~7 days,
  seller-adjustable, one-tap renew — which doubles as the business plan's
  staleness defense). Expired and sold posts roll into the **profile gallery**:
  feed = what's live; profile = who this seller is. Zero cleanup burden.
- **Confirmed sales vs stickers.** Anyone can sticker a card sold (flex is
  allowed). A **confirmed sale** — the buyer taps "got it" in the DM thread
  where the deal closed — earns a subtle verified mark and is what counts
  toward reputation. Fake flexing stays possible and earns nothing.
- **Fame = confirmed sales.** The `user_profiles.reputation` field (already
  rendered as "Fame" on every profile, currently written by nothing) finally
  gets its writer.
- Friction removal: mark-sold available inside the DM thread (one tap, in
  context); expiry nudge with bulk "did any of these sell?" marking.

## 9. Trust ladder (not a wall)

1. **Verified shops** — badge, storefront, rules-based buylists with payout
   rates ("85% of market on PSA 7+"), validity windows. Highest trust, anchor
   the market (per the July business plan). Shop buylists also give scan-to-offer
   its density: one shop's rules put a standing offer under thousands of cards.
2. **Proven collectors** — confirmed-sale count, account age, clean report
   history; Fame + the sold gallery are visible credit.
3. **New accounts** — can post; UI is honest ("New seller · no confirmed sales
   yet"); reach can ramp with track record.

Scam pressure never disappears in P2P, but the levers here beat IG's: every deal
has an in-app trail, reports/blocks/moderation already run on all posts and
media, demand-side matching means buyers often initiate, and reputation is
structural. **Design note:** structured listing fields (prices, criteria, any
URL outside the body) bypass BOTH existing moderation layers, which read only
`body` — the schema/moderation design must close that before launch. CSAM
hash-matching remains a listed prerequisite before image volume scales (per the
moderation worker's own header).

## 10. Growth loop: the auto-flyer

Shops pay designers for buyback flyers; collectors screenshot lists. Composing a
buylist/sale post in-app **auto-generates the beautiful shareable graphic**
(logo, rates, date window, card art from the catalog) for cross-posting to IG —
free design for them, branded distribution for us. Meet the existing ritual;
every story share is an ad. The same applies to collector sale binders.

## 11. Deliberately-open questions

1. **The P2P question (biggest).** The July business plan's trade matrix says "a
   vendor is always on one side of every trade" and defers collector↔collector
   as "the trust cliff." This concept opens that cell (collector sale posts).
   Options: frame v1 as shops+buy-side-open (collector WTB is trust-safe) with
   collector selling gated behind the trust ladder; or consciously revise the
   plan. Needs a decision informed by how the Aug show actually went.
2. **MVP slice.** Candidates discussed: (a) single-card sell/want posts + PDP
   surfacing + wishlist pings; (b) buylists-first (shops); (c) the feed surface
   first. Not chosen yet.
3. **Shops in v1?** User leans yes ("they can do it too; higher trust") but
   founding-partner readiness is unknown.
4. **Video scope.** Photos-first vs video-in-v1 (binder flip-throughs are core
   to the culture). Undecided.
5. **Payments** — explicitly out of scope indefinitely; revisit only per the
   business plan's Phase 2 (reserve → checkout) if ever.

## 12. Explicitly NOT building

- Auctions, bids, timers, escrow, in-app payments
- Exclusive/atomic claims (rejected in favor of parallel Interested→DM threads)
- Post-type pickers, listing forms, filter-builder UIs
- Confirmation dialogs for tags/wants (silent inference + lazy correction)
- A public directory of who owns / who wants what (privacy: pings only)
- Per-card listing fees (business plan: "NEVER")

## 13. What already exists (verified 2026-08-28 — the build is closer than it looks)

| Need | Existing hook |
|---|---|
| Listing post storage | Supabase `posts` (+ sidecar table per social_23's join-table precedent); `posts.card_id` attachment hook is live, indexed (`fetchCardPosts`), and written by NOBODY — free to claim |
| Photos | `post_media` + `POST /api/v1/post-media` — already moderated (2-min worker), private GCS |
| Seller surface | `FOR_SALE_TAB_ENABLED = false` (`features/profile/for-sale-tab.ts`) — dark-launched tab on every profile, one-line flip |
| Reputation slot | `user_profiles.reputation` rendered as "Fame", written by nothing |
| Deal channel | DMs + `sendMessage(..., {sharedPostId})` + shared-post bubble — "message about this listing" is fully plumbed |
| Demand index | `card_favorites` + `idx_card_favorites_card_id` ("who wants this card" is one query) |
| Supply hooks | `POST /api/v1/deck/entries/listing` (mark-as-listed endpoint, zero UI callers); collections fully priced |
| Notifications | `notifications.type` is unconstrained text — a new type needs NO migration; client union is a one-line edit |
| Push | Not built; complete spec in `notifications-market-signals-plan-2026-07-15-TABLED.md` (M3 needs a native build; M4 is nearly this feature's matcher) |
| Slab reading | PSA label/cert OCR exists in the scanner's slab lane |
| Text vocab | Search alias tables (sets, rarities, "sir/alt art/full art…") from the rarity-buckets + search work |
| Moderation | Posts/comments text + media auto-moderated; DMs word-list-gated; UGC safeguards declared to Apple (24h commitment) |

**Architecture seam to design around:** posts live in Supabase (client-direct,
RLS); collections/wishlists/prices live in the backend VM. The matcher crosses
that boundary joined only by `card_id` — it must live server-side (market-signals
pattern).

**Legal/App Store deltas before launch:** ToS §9/§10/§11/§13 currently declare
"we are not a marketplace / not a party to any transaction / non-commercial use /
free of charge" — needs counsel-reviewed amendment for listing features; privacy
policy's "private to your account" table if demand signals surface to sellers
(the ping design above avoids most of this); external links must keep opening in
Safari (age-rating answer); no IAP declaration changes needed while payments
stay external.

## 14. The pitch, in the words that landed tonight

- "Every card scanner tells you what it's worth. Ours tells you who wants it."
- "Post the same photo you post on IG. It reaches everyone hunting those exact
  cards — not just your followers — your sold record becomes proof you sell
  heat, and it expires on its own so you never babysit it."
- "An IG story dies in 24 hours and matches nothing. Here, your want ad hunts
  while you sleep."
