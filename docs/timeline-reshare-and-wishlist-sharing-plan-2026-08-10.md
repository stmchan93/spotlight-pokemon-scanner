# Reposts on the timeline, and sharing a wishlist — plan

**Date:** 2026-08-10
**Status:** proposal, nothing built

---

## Why this exists

Two separate asks landed together, and they are worth separating before either is built:

- The feed's reaction row in Figma has a **repeat/reshare** glyph. It has never been built,
  because nothing in the schema backs it — the note is already in
  `post-card.tsx:231-233`. An inert button was the wrong thing to ship, so it was left out.
- The wishlist now has a **share** button, and it shares the list as text. That works today,
  but it is the small version of the idea.

They feel like one feature ("sharing") and are not. One is **amplification inside the app**,
the other is **getting content out of it**. They need different plumbing, and only one of
them needs a database change.

---

## The distinction that matters

**Share = out of the app.** The OS share sheet. Nothing to store, nobody to notify. This is
what the wishlist button does now and what card detail already did per-card.

**Repost = inside the app.** Someone else's post appears on your timeline, attributed to
them. This is a real content type: it needs a row, it participates in the feed, in
moderation, in blocks, and in notifications.

Building the second one and calling it "share" is how you end up with a button that does
something nobody expected.

---

## What we have vs what we need

### Have
- `posts`, `post_media`, `post_likes`, `comments`, `follows`, `blocks`, `mutes`
- Counter triggers already maintain `posts.like_count` / `comment_count`
  (`social_09`, `SECURITY DEFINER` — the reason it works at all)
- `notifications` with a free-text `type` and a `post_id` column already on it
  (`social_03:7-17`) — a `reshare` type needs **no schema change here**
- A post permalink route: `app/(stack)/post/[postId].tsx`
- Moderation: `content_status`, the wordlist prefilter, the async worker, the report queue

### Need for repost
- One column: **`posts.reshared_post_id`** (nullable, FK → `posts.id`)
- A `reshare_count` counter + trigger, mirroring `like_count`
- Feed query changes to hydrate the reshared post
- Moderation and block rules for the *inherited* content (the hard part — see below)

### Need for a public wishlist
- A way to expose favourites publicly at all — today they are private, and the public
  profile has Collection / For Sale / Activity with **no Wishlist tab**
- An opt-in, and an RLS policy
- A share URL that resolves for someone who does not have the app

---

## Recommended design: a repost is a post

Store it as **`posts.reshared_post_id`** rather than a separate `post_reshares` table.

A reshare then *is* a post, which means it inherits — for free — the feed query, RLS,
moderation, the counter triggers, the report flow, and author-delete. A separate table
means a union in every feed read and a second copy of every rule, which is where the bugs
would live.

It also gives **quote-reposts for nothing**: `body` filled in plus `reshared_post_id` set is
a quote; `body` null is a plain repost. Same row, same rules.

```
posts
  id
  author_id            -- who reposted
  body                 -- null = plain repost, text = quote repost
  reshared_post_id     -- NEW: the post being amplified
  content_status
  like_count / comment_count / reshare_count   -- NEW counter
```

### The rules that actually need deciding

These are the ones that bite, and each is a product call:

1. **Moderation is inherited, and it must be.** If the original is removed, the repost must
   stop rendering the original's body — otherwise removal is trivially defeated by anyone
   who reposted it first. The repost row can survive as a tombstone; its *content* cannot.
2. **Blocks cut both ways.** A repost of someone you blocked must not reach you, even if the
   reposter is someone you follow. `is_blocked` is either-direction (`social_00`), so the
   feed filter has to check the **original author** as well as the reposter.
3. **No chains.** Reposting a repost points at the **root** post, not the repost. Otherwise
   you get a linked list to walk on every feed render, and a broken middle link takes the
   chain with it.
4. **Un-repost = delete your repost.** No new mechanism; author-delete already exists
   (`social_17`).
5. **Notify the original author** — `type: 'reshare'`, `post_id` = the new repost. No schema
   change needed.
6. **Self-repost:** allow it. It is how people resurface their own listing, and blocking it
   invites workarounds that are worse.

### What I would *not* do
- No repost counter shown until there is enough volume for it to read as anything but zero.
- No "reposted by" fan-out into a separate feed lane. It is a post; it goes in the feed.

---

## Sharing a wishlist

**Shipped today:** the list as text, filters and search carried through, capped at 25 lines
with the remainder named. No link, because there is nothing to link to.

**The fuller version** is a public wishlist — a 4th profile tab and a URL you can send.
That is the actual "share my hunt list" experience, and it is a feature rather than a
button:

- Opt-in, not on by default. A wishlist says what you *want*, which is exactly the
  information someone can price against you at a show. That is a real consideration for the
  people using this at shows, not a hypothetical.
- An RLS policy exposing favourites for opted-in users only
- A tab on `public-profile-screen` (the `FOR_SALE_TAB_ENABLED` pattern is the precedent for
  shipping a tab dark)
- A URL that resolves for a recipient **without the app** — which today it does not, because
  there is no web surface. Until there is, a shared link is a deep link that fails for
  anyone who has not installed.

That last point is the honest blocker: a public wishlist is only worth building when the
link works for the person you sent it to.

---

## Sequencing

1. **Repost, plain only** (no quote). One migration, one counter, the four rules above.
   This is the one with real product value — it is how a small feed gets circulation.
2. **Quote-repost.** Free once (1) exists; ship separately so the moderation of quote text
   is its own change.
3. **Public wishlist tab** — after, and only if the link problem is solved.

Do **not** bundle these. (1) touches the feed's read path, which is the highest-traffic
query in the app.

---

## Open questions

- **Repost with or without quote first?** I would ship plain first; quoting adds a second
  moderated text surface.
- **Does a repost show in the reposter's profile Activity tab?** I think yes — it is
  something they did.
- **Should a public wishlist wait for a web surface?** I think yes, and that it is the
  deciding constraint rather than the RLS work.
