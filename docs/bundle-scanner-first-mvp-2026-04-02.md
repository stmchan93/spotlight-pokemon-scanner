# Bundle Scanner First MVP

Date: 2026-04-02

Update: see [spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md) for the current source of truth. This document is now background only. Where it assumes a result-screen-first flow, the current scanner stack direction supersedes it.

This document narrows the active build target to the smallest version worth shipping internally.

## Decision

Do not build the full dealer tool first.

Do not build:

- eBay sync
- Deal Log
- Want List
- bundle pricing math
- aggregate low / mid / high totals

Keep those in the broader product docs as later phases.

Active build target:

- scan one photo
- identify one card
- show best match
- allow quick correction if wrong

That is the real first milestone.

## Why This Is The Right Cut

Right now the biggest unknown is not UX polish.

It is:

- can we reliably identify a card from a single mobile photo?

If scanning does not work, the rest of the product does not matter.

So the practical order is:

1. prove single-card scan works
2. prove match correction is usable
3. then add pricing
4. then add bundle aggregation
5. then add operational dealer workflows

## Bare Minimum MVP Definition

The true MVP is not yet a "bundle scanner" in the full sense.

It is closer to:

- `single-photo card identifier`

### Success condition

A dealer can take or upload one photo of one card and get:

- likely card name
- set
- card number if available
- variant / parallel if available
- confidence level

If the result is wrong, they can pick from alternate matches or search manually.

## MVP Scope

### In scope

- camera capture for one card
- photo upload fallback
- image crop / framing guide
- identify one card from one image
- best-match result screen
- alternate matches
- manual search fallback
- local session history of recent scans

### Out of scope

- live continuous scanning
- multi-card bundle math
- suggested bundle price
- eBay sync
- Deal Log
- Want List
- inventory
- exports
- buyer contact capture

## Recommended MVP Screen Set

This should be only 3 screens for now.

### 1. Scanner

Purpose:

- capture one card photo as reliably as possible

Must have:

- full-screen camera
- card framing guide
- capture button
- import photo
- flash
- tiny helper text for glare / background

Should not have:

- bundle totals
- pricing widgets
- tabs
- complex filters

### 2. Match Result

Purpose:

- show the most likely identified card

Must have:

- card image thumbnail
- card name
- set name
- card number
- variant / parallel if known
- confidence label
- button: `Use This Match`
- button: `See Other Matches`
- button: `Search Instead`

### 3. Match Alternatives / Manual Search

Purpose:

- recover cleanly when the scan is uncertain or wrong

Must have:

- 3 to 5 alternate matches
- search field
- tap to select corrected match

## What The Scanner Screen Should Look Like

The scanner should feel almost empty.

Top:

- simple title: `Scan Card`

Middle:

- large camera frame
- visible card outline

Bottom:

- primary capture button
- import photo
- flash toggle

Very small helper text:

- `One card only`
- `Avoid glare`
- `Keep card inside frame`

That is enough.

## What The First Result Screen Should Look Like

The result screen should not pretend to know pricing yet if pricing is not implemented.

It should focus on identity:

- `We think this is: Charizard ex 223/197`
- confidence badge
- set / number / rarity / variant
- `Looks wrong?` secondary correction actions

The goal is to learn:

- does the model identify correctly?
- what kinds of mistakes happen?
- how often does the user need correction?

## Recommended Build Order

### Step 1

Camera or photo upload -> send image -> return best candidate.

### Step 2

Show result with confidence and alternate matches.

### Step 3

Add manual text search to recover from bad matches.

### Step 4

Only after identity works, add pricing lookup on the confirmed match.

### Step 5

Only after pricing works, add bundle accumulation.

## What To Measure First

Before talking about pricing, measure:

- scan success rate
- average time from capture to result
- correction rate
- top failure cases
  - glare
  - bad crop
  - wrong variant
  - wrong set
  - unreadable card number

## Product Principle

Do not hide the actual risk.

The risk is not whether dealers want bundle pricing.

The risk is whether the scanner can identify cards accurately enough to be trusted on a show floor.

## Deferred Features

These remain valid later, but are not first build:

- bundle scanner with running list
- aggregate low / mid / high totals
- suggested dealer bundle price
- Deal Log
- Want List
- eBay sync
- post-show reconciliation

## One-Sentence Active Scope

Build the fastest possible `single-card scan -> confirm card identity` flow first, then layer pricing and bundle logic on top of a working identification system.
