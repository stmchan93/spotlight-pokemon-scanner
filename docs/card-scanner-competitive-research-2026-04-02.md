# Card Scanner Competitive Research

Update: see [spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md) for the current build/status summary. This document remains background research and competitive context.

Date: 2026-04-02

Goal: Define a practical product direction for an event-owned app that can scan one card and return min/max/avg pricing very quickly, with strong manual search fallback.

## Executive Summary

The three products do not solve the exact same problem:

- PSA is the best reference for a scan-first collector workflow. It combines scan, pricing, portfolio, grading submission, and selling.
- PriceCharting is the best reference for price-detail layout, condition/grade segmentation, and search fallback.
- Alt is the best reference for premium marketplace and consignment UX, but it is not the best model for raw-card, on-site event scanning because it is heavily built around graded cards, vaulting, and selling workflows.

There is also a broader competitive set for raw Pokemon cards:

- TCGplayer is strong for scan plus marketplace pricing signals like Market Price, Listed Median, and Most Recent Sale.
- Ludex is strong for scan-first flows, recent sales, price report, and collection/listing handoff.
- Dragon Shield is strong for Pokemon-specific scanning, trade comparison, and collection/deck utilities.
- Collectr is strong for portfolio tracking, trends, and collection-level analytics.

If your event app needs "scan one card, get price context fast", the strongest product direction is:

1. Use PSA's scan-first entry point.
2. Use PriceCharting's results structure and manual search fallback.
3. Avoid Alt's marketplace complexity unless your event truly needs in-app consignment or selling.
4. Learn from TCGplayer, Ludex, Dragon Shield, and Collectr for batch scanning, collection value, and trade-oriented workflows.

## What Each App Is Optimizing For

### Alt

Primary job to be done:
- Sell, vault, value, and manage higher-value cards, especially graded cards.

Product posture:
- Premium marketplace.
- Seller and consignment oriented.
- More finance and transaction driven than collector utility driven.

Evidence:
- Alt's Google Play description emphasizes 24/7 auctions, fixed-price marketplace, cash advances, collection management, sales data, and saved searches.
  - Source: https://play.google.com/store/apps/details?hl=en_US&id=com.onlyalt.altapp
- Alt's help center says Instant Pricer is "the fastest way to get comps" for graded PSA/BGS cards and is launched from Browse via a camera icon.
  - Source: https://support.alt.xyz/en/articles/9213562-instant-pricer
- Alt's Snap to Sell flow is photo -> AI identification -> valuation -> cash advance -> ship to Alt.
  - Source: https://support.alt.xyz/en/articles/10715764-snap-to-sell-how-to-consign-your-cards-on-alt
- Alt explicitly says raw cards are not currently accepted for sale through Snap to Sell.
  - Source: https://support.alt.xyz/en/articles/10715764-snap-to-sell-how-to-consign-your-cards-on-alt

### PSA

Primary job to be done:
- Identify and price cards quickly, then push users into grading, portfolio management, and resale.

Product posture:
- Scan-first utility wrapped around grading and collection operations.
- Strongest end-to-end collector funnel.

Evidence:
- PSA's official app page says users can scan to research card details, estimates, sales, active eBay listings, and PSA population.
  - Source: https://www.psacard.com/info/apps
- PSA's app store description positions the app as an all-in-one card scanner that identifies cards, prices them, tracks portfolio value, verifies certs, manages submissions, and lists on eBay.
  - Source: https://apps.apple.com/us/app/psa-authentic-trading-cards/id996239729
- PSA's assisted submission flow starts with "Scan or Input Your Cards", then recommends service levels from estimated graded value.
  - Source: https://www.psacard.com/info/how-to-submit/assisted

### PriceCharting

Primary job to be done:
- Fast collectible identification plus deep pricing and collection tracking.

Product posture:
- Search and data product first.
- Less polished than PSA or Alt, but more directly useful for quick valuation and research.

Evidence:
- PriceCharting's app page highlights "Search by photo", "Robust search feature", and "Daily updated prices & item database".
  - Source: https://www.pricecharting.com/page/app
- The Google Play app description emphasizes pricing by condition, historical sales, wishlists, and collection tracking.
  - Source: https://play.google.com/store/apps/details?id=com.vgpc.pricecharting
- The iOS app description also highlights barcode/photo search, lot creation, and grading recommendations.
  - Source: https://apps.apple.com/us/app/pricecharting-tcg-games/id6452190948

## Broader Competitive Set For Raw Pokemon Cards

### TCGplayer

Primary job to be done:
- Scan TCG cards, check current marketplace pricing, and move directly into seller workflows.

Product posture:
- Marketplace and seller utility first.
- Better for raw TCG card pricing than Alt.
- More transactional than presentation-heavy.

Evidence:
- TCGplayer's app FAQ says users can scan cards from every game on TCGplayer, keep them in a temporary list, save them to collections, and import them into seller inventory.
  - Source: https://help.tcgplayer.com/hc/en-us/articles/115009506407-TCGplayer-App-FAQ
- The same FAQ says the app provides Market Price, Listed Median, and Most Recent Sale.
  - Source: https://help.tcgplayer.com/hc/en-us/articles/115009506407-TCGplayer-App-FAQ
- TCGplayer's Market Price article says Market Price is based on actual recent sales and averages across multiple recent transactions while ignoring outliers that would affect traditional low-mid-high price scales.
  - Source: https://help.tcgplayer.com/hc/en-us/articles/213588017-TCGplayer-Market-Price

Product takeaway:
- Best reference for raw-card marketplace price signals and temporary scanned lists.
- Weaker as a clean event-facing valuation UI.

### Ludex

Primary job to be done:
- Scan quickly, verify card details, view price report, then add to collection or list for sale.

Product posture:
- Scanner-first with portfolio and selling attached.
- Operationally closer to your desired flow than Alt.

Evidence:
- Ludex's scan page says the scan detail view shows recent sales, card info, an estimated price, last sold price, and card sales over time.
  - Source: https://www.ludex.com/scan-and-price/
- Ludex memberships include portfolio, collections, and TCG decks.
  - Source: https://www.ludex.com/scan-and-price/
- The Android app description says values are based on completed eBay sales and other marketplaces.
  - Source: https://play.google.com/store/apps/details?hl=en-US&id=com.ludexmobile

Product takeaway:
- Best reference for fast scan-to-detail handoff plus collection/listing actions.
- Still not optimized around a live buyer-vendor deal workflow.

### Dragon Shield Poke TCG Scanner

Primary job to be done:
- Help Pokemon collectors and players scan cards, check prices, compare trades, and manage folders/decks.

Product posture:
- Pokemon-specific utility app.
- More trade and collection oriented than marketplace oriented.

Evidence:
- Dragon Shield's Card Manager says users can scan cards, track what they are worth, and track total collection value.
  - Source: https://www.dragonshield.com/card-manager
- The Pokemon app description says users can scan cards in any language, check daily prices from TCGplayer and CardMarket, and explore 30-day price history charts.
  - Source: https://play.google.com/store/apps/details?hl=en&id=pt.tscg.pokemanager
- The same app description says users can compare trade values between two players instantly and track cards rising or falling in price.
  - Source: https://play.google.com/store/apps/details?hl=en&id=pt.tscg.pokemanager

Product takeaway:
- Best reference for Pokemon-only UX, trade comparison, and collection folders.
- More player/collector oriented than event-vendor oriented.

### Collectr

Primary job to be done:
- Track a collection like a portfolio and monitor gains, losses, and market trends across many TCGs.

Product posture:
- Portfolio and social product first.
- Scanning supports the portfolio, not the other way around.

Evidence:
- Collectr's site says users can scan, catalog, and track collectibles, and stay current with market trends and valuations.
  - Source: https://getcollectr.com/
- Collectr Pro includes unlimited scanning, in-depth pricing data, saved search history, and export.
  - Source: https://getcollectr.com/pro
- The app descriptions emphasize raw, graded, and sealed collection tracking, trends, biggest gainers/losers, and trade analyzer.
  - Sources:
    - https://apps.apple.com/us/app/collectr-tcg-collector-app/id1603892248
    - https://play.google.com/store/apps/details?id=com.collectrinc.collectr

Product takeaway:
- Best reference for persistent portfolio value and trend views.
- Weaker as a pure event-speed card appraisal tool.

## How The Market Splits Today

The market is not one category. It is several overlapping product types:

- Alt: graded-card marketplace and consignment
- PSA: scan-to-grade collector funnel
- PriceCharting: pricing database and search
- TCGplayer: scan plus marketplace pricing and seller tools
- Ludex: scan plus portfolio plus selling
- Dragon Shield: Pokemon-focused scanner, trade, and collection utility
- Collectr: portfolio and trends

This matters because your app should not try to beat all of them on all axes at once.

## Your Event Context

Your actual use case is different from most of the apps above.

You are not primarily building:

- a grading funnel
- a vault
- a mass online marketplace
- a social collector app

You are primarily building a live event utility for two roles:

### Buyer / attendee job to be done

- See a card at a booth
- Scan or search it fast
- Understand what it is worth right now
- Decide whether the asking price is fair
- Save cards they are considering
- Build a temporary stack of cards for a possible deal

### Seller / vendor job to be done

- Scan cards quickly during conversations
- Understand a fair sale range
- Aggregate multiple cards into a running total
- Build a reusable tray, binder, or stack of inventory
- Quote buyers faster without manually searching card-by-card

That is a narrower and better-defined product than "general card app."

## Wedge Analysis

The likely wedge is not "scan cards." Many apps already scan cards.

The likely wedge is:

- event-speed multi-card valuation
- shared deal context for buyer and seller
- a cleaner fair-value presentation than marketplace apps
- event-native workflows like booth use, quick quote, and saved deal stacks

### What existing apps do well

- PriceCharting: single-card pricing detail and history
- TCGplayer: marketplace pricing primitives and temporary lists
- Ludex: scan-first flow with price report
- Dragon Shield: Pokemon-specific trade and folder tools
- Collectr: collection and trend views

### What they do not cleanly own

- A live "deal mode" where multiple scanned cards instantly roll into an aggregate low / avg / high total
- A product designed for both sides of a convention-floor negotiation
- A very fast temporary inventory object for an in-progress sale
- Event-specific sharing and quoting workflows

## Recommended Product Object: Deal Stack

Do not call this a "deck" in the product unless it literally represents a playable deck.

For your use case, the better object is something like:

- Deal Stack
- Scan Stack
- Quote Stack
- Vendor Tray

Why:
- "Deck" means something very specific in TCG apps.
- Your object is really a temporary or persistent set of scanned cards tied to a pricing conversation.

Recommended behavior for a Deal Stack:

- Add by scan
- Add by search
- Running item count
- Running low / avg / high totals
- Last updated timestamp
- Per-card confidence / match correction
- Notes
- Share or export

This object can start temporary in V1 and evolve into persistent inventory later.

## Screen and Layout Patterns

### Alt: What the UI is doing

Observed pattern:
- Dark, premium visual style.
- Camera entry point is available from Browse.
- Photo-led flows are embedded inside selling or research workflows, not isolated as a standalone scanner product.
- Strong emphasis on single-task full-screen flows with obvious next CTA.

What is good:
- High-value items feel premium.
- Camera as a top-level action is correct.
- Strong next action after a match: price, consign, or view details.

What is risky for your use case:
- Too much marketplace and vault complexity for an event floor.
- Narrower support for programmatically identified and graded inventory.
- Recent review feedback points to clutter for single-category users and scan freezes after updates.
  - Source: https://play.google.com/store/apps/details?hl=en_US&id=com.onlyalt.altapp

Product takeaway:
- Copy the "camera is always one tap away" principle.
- Do not copy the broader IA unless you are building a full marketplace.

### PSA: What the UI is doing

Observed pattern:
- The brand makes scan the hero action.
- Operational screens are simple, white-card list views with a single strong CTA.
- Price and identity act as the front door into deeper flows: portfolio, grading, reveal, selling.

What is good:
- Very clear scan-first story.
- Strong sense of progress and next step.
- Clear split between acquisition screens and operational list/detail screens.

What is risky for your use case:
- PSA's product is optimized to convert users into grading and vault workflows, which you probably do not need for an event app.
- User feedback still shows scan-by-photo can miss, which means a strong fallback search is mandatory.
  - Source: https://play.google.com/store/apps/details?hl=en_US&id=com.psacard.certverification

Product takeaway:
- Copy the scanner prominence and linear flow design.
- Do not let grading or secondary workflows crowd the first-use experience.

### PriceCharting: What the UI is doing

Observed pattern:
- Light, data-dense, utility-first UI.
- Item detail screens prioritize chart plus pricing chips/segments.
- Search and collection views are always nearby.
- The product openly handles uncertainty with "Best Matches" and low-confidence prompts.

What is good:
- Best reference for your actual pricing screen.
- Strong manual search fallback.
- Condition and grade segmentation is visible and understandable.
- Collection summary views use charts and simple summary cards rather than heavy marketplace chrome.

What is risky for your use case:
- Scan accuracy is imperfect, per official reviews.
- If you copy the full data-dense layout, you may slow down event usage.
  - Sources:
    - https://play.google.com/store/apps/details?id=com.vgpc.pricecharting
    - https://apps.apple.com/us/app/pricecharting-tcg-games/id6452190948

Product takeaway:
- Copy the result structure.
- Compress it into an event-speed version with the price summary above the fold.

## What Users Actually Need In The First 10 Seconds

Across these products, the successful pattern is not just "scan and show a price". It is:

1. Detect the card quickly.
2. Confirm the likely match.
3. Show a small number of trustworthy price stats immediately.
4. Give one-tap access to deeper sales data.
5. Provide manual search when confidence is low.

For your event app, the first screen after scan should answer:

- What card do you think this is?
- How confident are you?
- What is the low / average / high range?
- Is this raw or graded pricing?
- How many comps is this based on?
- How fresh is the data?

That is more valuable than copying any single competitor screen 1:1.

## Recommended Product Direction For An Event App

### Core principle

Your app should be a "fast appraisal tool", not a marketplace with scanning attached.

That means the primary loop is:

1. Scan
2. Confirm match
3. View price snapshot
4. Add to a Deal Stack when relevant
5. Search or inspect sales if needed
6. Save/share to event workflow

### Recommended navigation

Bottom nav:

- Home
- Scan
- Search
- Stacks
- Event

Why:
- Scan and Search need permanent top-level access.
- Stacks gives users a lightweight working set during the event, and can later become persistent inventory for vendors.
- Event is where you can put show-specific tools later: booth map, dealer notes, in-house offers, trade desk, check-in, or queue state.

## Recommended Screen Stack

### 1. Home

Purpose:
- Lightweight launch pad, not a dashboard maze.

Modules:
- Primary CTA: Scan a card
- Secondary CTA: Search manually
- Recent scans
- Event shortcuts
- Recent stacks
- Saved searches

Do not include:
- Deep charts
- Marketplace feed
- Newsfeed-style clutter

### 2. Scanner

Purpose:
- Fastest possible capture and match handoff.

Layout:
- Full-screen camera
- Card outline guide
- Auto-detect capture
- Flash toggle
- Photo import
- Tiny category picker only if required

Important behavior:
- Auto-crop and straighten card before upload.
- If confidence is low, do not jump directly to a wrong result. Show best matches.

Best references:
- PSA scan-first positioning
- Alt camera-as-primary-research-entry

### 3. Match Confirmation

Purpose:
- Prevent false confidence.

Layout:
- Top image thumbnail
- Primary match card
- Confidence label
- 3 to 5 alternate matches
- Manual search field already focused or immediately available

This screen matters because scan misses are a known pain point in PSA and PriceCharting reviews.

### 4. Price Result

Purpose:
- Deliver the value answer above the fold.

Above the fold:
- Card image
- Name, set, number, rarity/parallel
- Confidence or verified match badge
- Price chips:
  - Min
  - Avg
  - Max
  - Last sale
- Metadata:
  - Raw / grade basis
  - Number of comps
  - Updated at

Below the fold:
- Recent sales list
- Price trend chart
- Grade tabs or chips:
  - Raw
  - PSA 8
  - PSA 9
  - PSA 10
- Alternate versions / parallels

Best reference:
- PriceCharting's detail structure

### 5. Search

Purpose:
- Reliable fallback and power-user entry point.

Requirements:
- Fast typeahead
- Search by player/name/set/number/year/grade
- Fuzzy matching
- Search history
- Filters only after first result set, not before

Result cards should show:
- Thumbnail
- Full title
- Set / number
- Small price preview
- Badge for exact match vs variation

### 6. Stacks / Working Set

Purpose:
- Let users compare, total, and revisit cards during the event.

Useful actions:
- Save card
- Add card to a stack
- Add notes
- Share price result
- Export quick valuation list
- Show running low / avg / high totals

This should start simple and can be temporary at first, not a full inventory-management clone.

### 7. Event

Purpose:
- Your actual differentiator.

Potential modules:
- Booth or dealer association
- Trade desk queue
- In-house buy offer workflow
- QR share of results
- Staff mode
- Offline pending uploads

## Feature Parity: What To Match vs What To Skip

### Must match in V1

- Scan by photo
- Manual search fallback
- Best-match confirmation
- Min / avg / max pricing snapshot
- Last sale
- Recent sales list
- Grade or condition segmentation
- Add card to temporary Deal Stack
- Running stack totals
- Search history / recent scans

### Should match soon after

- Barcode or cert scan where relevant
- Vendor folders or persistent stacks
- Shareable result view
- Alerts or watched cards
- Better image capture guidance
- Quote mode for buyer vs seller

### Skip for now

- Vault
- Grading submission
- Auction bidding
- Cash advances
- Consignment chat
- Full listing management
- Complex social/community features

## Data Semantics For "Current Price"

If you say "current moment" or "current price", you need to define that internally and in the UI.

No app actually knows the perfect true price of a card at a literal moment in time. What they do is combine one or more of:

- recent completed sales
- current marketplace listing data
- condition filters
- grade filters
- comparable-card inference when exact sales are sparse

For your product, I would define price primitives explicitly:

- Low recent comp
- Avg recent comp
- High recent comp
- Last sold
- Active ask median
- Comp count
- Lookback window

Then derive event-friendly views from those primitives:

- Fair Buy
- Fair Sell
- Negotiation Range

This is a better wedge than pretending a single number is the truth.

## Data Model and Pricing UX Recommendations

If your promise is "min / max / avg very fast", the UI should never show a single opaque number by default.

Recommended default pricing block:

- Avg price
- Low recent comp
- High recent comp
- Last sale
- Comp count
- Date window

Optional second row:

- Raw
- PSA 9
- PSA 10

Important:
- Show when data is sparse.
- Show when price is inferred from comparables rather than exact-card sales.
- Do not merge raw and graded values into a single summary number.
- Show whether the number is based on sold comps, active listings, or both.

This is where Alt is informative: its help center explains that when exact data is sparse, its value model uses comparable transactions and market knowledge rather than simple averaging.
- Source: https://support.alt.xyz/en/articles/9213547-collection-management

## Speed Requirements For The Product

For an event environment, speed matters more than feature breadth.

Recommended targets:

- Camera ready in under 500 ms after opening
- Photo capture to first match in under 1.5 s median
- Match confirmation to price result in under 500 ms
- Typeahead search latency under 150 ms
- No more than 2 taps from scan result to corrected manual match

If you cannot hit those targets, the product will feel worse than competitors even if the data is good.

## Phased Scope Recommendation

The inventory vision makes sense, but full inventory management is not the right first battle.

Recommended phases:

### Phase 1: Appraisal and deal flow

- Scan one card
- Confirm match
- Show low / avg / high / last sale
- Add to Deal Stack
- Aggregate stack total
- Share or export quote

### Phase 2: Seller trays

- Named persistent stacks
- Notes and asking price
- Quantity
- Better export
- Booth-specific folders

### Phase 3: Inventory system

- Full inventory state
- Cost basis
- Sold status
- Bulk edit
- Import / export
- Cross-event persistence

## Buyer Flow Spec

The buyer flow should optimize for speed, confidence, and low cognitive load.

Primary user intent:

- "Is this card priced fairly?"
- "Should I buy this right now?"
- "How much will this small pile cost me in total?"

### Buyer flow v1

1. Home
   Buyer lands on a simple screen with `Scan Card`, `Search`, and `Open Stack`.
2. Scan or search
   Buyer scans a card or types player / set / card number.
3. Match confirmation
   If confidence is not high enough, show best match plus alternates.
4. Price result
   Show low / avg / high / last sale above the fold.
5. Decision point
   Buyer can either:
   - add the card to a Deal Stack
   - save it for later
   - inspect recent sales
6. Stack review
   Buyer sees running totals for the cards they are considering.
7. Share or reference
   Buyer can show the stack to a vendor, friend, or event staff member.

### Buyer success criteria

- Reach trusted value context in under 10 seconds
- Correct a bad scan in under 2 taps
- Build a stack of 3 to 10 cards without losing speed
- Understand whether a booth price is below, within, or above a fair range

### Buyer-specific UX principles

- Do not force account creation before first scan
- Keep the first result screen focused on valuation, not collection management
- Make recent sales one tap away, not first-class clutter
- Make `Add to Stack` more prominent than `Save to Portfolio`

## Vendor Flow Spec

The vendor flow should optimize for throughput, aggregate totals, and quoting speed during live conversations.

Primary user intent:

- "What should I charge for this card?"
- "What is a fair total for this pile?"
- "How do I quote quickly without searching every card manually?"

### Vendor flow v1

1. Open Quick Quote
   Vendor starts from `New Deal Stack` or `Vendor Tray`.
2. Continuous scan
   Vendor scans cards one after another into the active stack.
3. Lightweight correction
   If a match is wrong, vendor taps the line item and swaps the version quickly.
4. Running total
   The app continuously updates low / avg / high totals as each card is added.
5. Negotiation support
   Vendor can switch between:
   - Fair Buy
   - Fair Sell
   - Negotiation Range
6. Quote summary
   Vendor can show a clean quote screen with line items and total.
7. Save or discard
   Vendor can discard the temporary quote, save it as a tray, or export it.

### Vendor success criteria

- Scan and total 10 cards in under 60 seconds
- Correct a bad match without leaving the stack
- Show a buyer a defendable total immediately
- Turn an in-progress stack into a reusable tray later

### Vendor-specific UX principles

- Continuous scan should keep the camera loop alive
- Stack totals should remain visible while scanning
- Per-card quantity editing should be fast for duplicates
- Quote mode should hide charts and secondary details

## Deal Stack Screen Spec

The `Deal Stack` is the core object that differentiates the app from generic scanner apps.

### Object definition

A Deal Stack is a temporary or persistent set of scanned and searched cards used to:

- evaluate a possible purchase
- build a vendor quote
- compare negotiation ranges
- later evolve into inventory or trays

### Core fields

- Stack name
- Mode
  - Buyer
  - Vendor
- Card count
- Total quantity
- Running low total
- Running avg total
- Running high total
- Last updated time
- Pricing basis summary
- Notes

### Card line item fields

- Thumbnail
- Card title
- Set and card number
- Match confidence
- Condition / grade basis
- Quantity
- Low
- Avg
- High
- Last sale
- Warning state
  - low confidence
  - sparse comps
  - inferred price

### Main Deal Stack screen layout

Top bar:

- Stack name
- Buyer / Vendor mode pill
- Search button
- Share / export button

Summary header:

- Card count
- Total quantity
- Low total
- Avg total
- High total
- Optional quote total

Credibility layer module:

- Comp count
- Lookback window
- Last updated
- Pricing sources
- Mixed-data warning if some cards are inferred

List section:

- Card line items
- Inline quantity stepper
- Confidence badge
- Quick edit action

Sticky bottom action bar:

- Scan more
- Search add
- Show quote

### Empty state

The empty state should do almost nothing except help the user start fast.

Show:

- `Scan first card`
- `Search manually`
- `Import later` only if you actually support it

Do not show:

- portfolio graphs
- marketplace banners
- social feed

### Quote mode

Quote mode is a cleaner read-only presentation optimized for showing another human the number.

Show:

- stack title
- item count
- line items
- low / avg / high total
- optional fair buy / fair sell range
- pricing basis summary
- timestamp

Hide:

- confidence diagnostics that clutter the screen
- trend charts
- portfolio actions

### Item detail drawer

When tapping a line item, show a quick-edit drawer instead of a full page when possible.

Fields:

- alternate matches
- condition / grade selector
- quantity
- last sale
- recent sales shortcut
- remove item

This keeps the vendor and buyer inside the live stack flow.

## Credibility Layer Spec

The credibility layer is the most important trust system in the product.

Its job is to answer:

- Where did this number come from?
- How recent is it?
- How strong is the evidence?
- Is this exact-card data or inferred?

### Minimum credibility module on single-card result

- `Based on 12 sold comps`
- `Last 30 days`
- `Updated 2 min ago`
- `Sources: sold comps + active listings`
- `Confidence: high / medium / low`

### Minimum credibility module on Deal Stack

- `8 cards exact match, 2 cards inferred`
- `41 sold comps total across stack`
- `Lookback: 30 days`
- `Last refresh: 10:42 AM`

### Trust states

High trust:

- exact match
- healthy comp count
- recent sales
- clear condition / grade basis

Medium trust:

- exact match but low comp count
- stale data window
- mixed sources with thin sales volume

Low trust:

- uncertain match
- inferred from comparable cards
- missing condition alignment
- no recent exact-card sale

### Recommended copy patterns

Good:

- `Fair range based on recent sold comps`
- `Price inferred from similar recent sales`
- `Low-confidence match. Review version before quoting`

Avoid:

- `True price`
- `Exact value`
- `Guaranteed market value`

## Recommended Mode Design

Do not build separate apps for buyers and vendors.

Use one product with two lightweight modes:

- Buyer mode
  - emphasizes fair range and save-to-stack
- Vendor mode
  - emphasizes quote totals, quantities, and continuous scanning

The scan, search, pricing, and credibility systems should be shared.

## Recommended Wedge

The strongest wedge is:

- `fast, trustworthy deal quoting for live events`

Not:

- generic collection tracking
- generic scanner app
- generic marketplace

### Why this wedge is strong

- It is a real-time pain point on the convention floor
- Existing apps make users bounce between scan, search, pricing, and collection tools
- Very few products are optimized around multi-card negotiation speed
- Both buyers and vendors benefit from the same underlying workflow

### What the wedge looks like in product terms

- scan a card in seconds
- see fair range with evidence
- add to Deal Stack
- build a running total across multiple cards
- show a clean quote screen to another person

### Why not lead with inventory

Inventory management is valuable, but it is a weak initial wedge because:

- it is manual and time-consuming
- users need trust before they commit to data entry
- inventory products are easier to abandon if setup is heavy

### Better path

Lead with:

- scan
- price
- quote
- stack

Then let inventory emerge as a byproduct:

- saved stacks become trays
- trays become persistent folders
- folders become inventory

## V1 Screen Inventory

If you want the smallest coherent v1, the screen set is:

- Home
- Scanner
- Match Confirmation
- Price Result
- Search
- Deal Stack
- Quote Mode
- Quick Edit Drawer

That is enough to test the wedge without prematurely building full inventory.

## Biggest Risks Revealed By Competitor Research

### 1. False scan confidence

Users will forgive "I am not sure". They will not forgive confident wrong matches.

Evidence:
- PriceCharting's official flow explicitly warns on low-confidence results and suggests retaking the photo or searching by keywords.
  - Source: https://www.pricecharting.com/page/app

### 2. Too much IA for a narrow task

Alt shows what happens when the product grows around many jobs to be done: users complain about clutter and wasted clicks when they only care about one category or one task.
- Source: https://play.google.com/store/apps/details?hl=en_US&id=com.onlyalt.altapp

### 3. Scan-only is not enough

Both PSA and PriceCharting still need strong manual lookup because photo search can fail.

### 4. Raw versus graded confusion

Alt is largely graded-first. Your event app likely needs clearer support for raw cards, especially if people are scanning cards on-site before grading.

## Product Recommendation In One Sentence

Build a PSA-style scan entry, a PriceCharting-style result screen, and an event-specific Deal Stack flow, while avoiding Alt-style marketplace depth in V1.

## Suggested MVP Definition

If I were scoping the first version, I would build only this:

- Scan one card
- Return best match plus alternatives
- Show min / avg / max / last sale
- Separate raw and graded values
- Provide manual search
- Add cards into a temporary Deal Stack
- Show aggregate low / avg / high stack totals
- Share or export result or quote

Everything else is a second-phase decision.

## Sources

- Alt Google Play: https://play.google.com/store/apps/details?hl=en_US&id=com.onlyalt.altapp
- Alt Instant Pricer help: https://support.alt.xyz/en/articles/9213562-instant-pricer
- Alt Snap to Sell help: https://support.alt.xyz/en/articles/10715764-snap-to-sell-how-to-consign-your-cards-on-alt
- Alt Collection Management help: https://support.alt.xyz/en/articles/9213547-collection-management
- PSA Apps page: https://www.psacard.com/info/apps
- PSA Assisted Submission: https://www.psacard.com/info/how-to-submit/assisted
- PSA App Store: https://apps.apple.com/us/app/psa-authentic-trading-cards/id996239729
- PSA Google Play: https://play.google.com/store/apps/details?hl=en_US&id=com.psacard.certverification
- PriceCharting app page: https://www.pricecharting.com/page/app
- PriceCharting Google Play: https://play.google.com/store/apps/details?id=com.vgpc.pricecharting
- PriceCharting App Store: https://apps.apple.com/us/app/pricecharting-tcg-games/id6452190948
- TCGplayer App FAQ: https://help.tcgplayer.com/hc/en-us/articles/115009506407-TCGplayer-App-FAQ
- TCGplayer Market Price: https://help.tcgplayer.com/hc/en-us/articles/213588017-TCGplayer-Market-Price
- Ludex Scan and Price: https://www.ludex.com/scan-and-price/
- Ludex Google Play: https://play.google.com/store/apps/details?hl=en-US&id=com.ludexmobile
- Dragon Shield Card Manager: https://www.dragonshield.com/card-manager
- Poke TCG Scanner Dragon Shield Google Play: https://play.google.com/store/apps/details?hl=en&id=pt.tscg.pokemanager
- Poke TCG Scanner Dragon Shield App Store: https://apps.apple.com/us/app/pok%C3%A9-tcg-scanner-dragon-shield/id1199495742
- Collectr site: https://getcollectr.com/
- Collectr Pro: https://getcollectr.com/pro
- Collectr Google Play: https://play.google.com/store/apps/details?id=com.collectrinc.collectr
- Collectr App Store: https://apps.apple.com/us/app/collectr-tcg-collector-app/id1603892248
