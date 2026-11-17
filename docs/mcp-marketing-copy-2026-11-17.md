# Ekalight AI connector: marketing copy (2026-11-17)

Every claim here maps to a tool that exists today in `backend/mcp_server/app.py`. The "Coming soon" section covers what's planned in `docs/mcp-phase3-write-tools-plan-2026-11-17.md` and is NOT live. Keep it out of store copy until it ships.

## Positioning

**Tagline:** Your card collection, now in your AI assistant.

**One-liner:** Connect Ekalight to Claude or ChatGPT and ask what your collection is worth, what you're missing, and what to buy next. It answers from your real collection, not from a guess.

**Short blurb (App Store "What's New" / social):**
> New: Ekalight works inside Claude and ChatGPT. Log in once, then just ask: "What's my collection worth?" "Which cards are up this month?" "What am I missing from Surging Sparks under $50?" Your real collection, real USD prices, no exporting spreadsheets.

**Trust line (use near every CTA):** Read-only. The assistant can see your collection but can't change it, and you can disconnect anytime.

---

## The 6 pitches

### 1. Ask your collection anything
- **Headline:** Talk to your collection.
- **One-liner:** Ask what it's worth, what's grown, and what's slipping, in plain English.
- **Try asking:** "What's my collection worth, and how did it do this month?"
- **Social:** Your binder can't tell you it's up 12% this month. Ekalight in Claude can.
- *Backed by:* `get_portfolio_summary`, `get_my_collection`

### 2. Set completion on a budget (lead with this one)
- **Headline:** Your shopping list, written for you.
- **One-liner:** Ask what you're missing from any set or theme and get the cheapest cards first, under your budget, with buy links.
- **Try asking:** "What am I missing from Surging Sparks, under $50 total?"
- **Social:** Stop cross-checking checklists against your binder. Ask "what am I missing?" and get a priced shopping list in seconds.
- *Backed by:* `find_missing` (budget, cheapest-first, buy links)

### 3. Search by vibe, not just by name
- **Headline:** Find cards by how they look.
- **One-liner:** Search by scene, mood and color: cozy night scenes, beach days, purple art.
- *Caveat:* only tagged cards match (the tool reports coverage). "No other app does this" is unverified, so don't claim it until competitors are checked.
- **Try asking:** "Show me cozy night-scene Pokémon cards with purple art that I don't own."
- **Social:** "Rainy-day cards." "Sunset cards." "Cards that look like a lo-fi album cover." Now you can actually search that.
- *Backed by:* art tags + `list_facets` + `search_cards(owned="not_owned")`

### 4. Should I sell?
- **Headline:** See the trend before you decide.
- **One-liner:** Daily price history for any card, by condition, up to a year back.
- **Try asking:** "How has Umbreon VMAX Alt Art moved over the past year in Near Mint?"
- **Social:** Holding or folding? Ask for the 1-year chart before you list it.
- *Backed by:* `get_price_history` (raw cards; graded is coming soon)

### 5. Your JP card's English twin
- **Headline:** Every card, both languages.
- **One-liner:** Ask about a Japanese card and get its English version, price comparison and similar cards.
- **Try asking:** "What's the English version of this Japanese card, and which one is worth more?"
- *Backed by:* `get_card` (`language_pair`, `similar`)

### 6. Works where you already are
- **Headline:** No new app to learn.
- **One-liner:** Ekalight plugs into Claude and ChatGPT. Log in once and your collection is there.
- **Social:** Already use ChatGPT or Claude? Your card collection can live there too.

---

## Example prompt list (for a landing page or onboarding card)

- "What's my collection worth?"
- "Top 5 gainers and losers this month."
- "What am I missing from [set] under $[budget]?"
- "Show me [mood/scene] cards I don't own."
- "Price history for [card] over the last year."
- "What's the English version of this card?"

## Coming soon (NOT live; don't put in store copy)

- **"Add it to my collection."** Add cards, change quantity or condition, add to watchlist, all by chat.
- **Graded price trends.** "How has PSA 10 Charizard moved this year?"
- **Price alerts.** "Tell me when this drops under $40." The alert arrives as a push notification from the Ekalight app.
- **Snap to identify.** Upload a photo in chat and get the card and its price.

## Don'ts

- Don't say "AI scanner" or "AI grader" for the connector.
- Don't show any price in yen; USD only.
- Don't call it "Wishlist"; the copy says Watchlist.
- Don't promise live or real-time prices. Prices come from Ekalight's daily market data.
