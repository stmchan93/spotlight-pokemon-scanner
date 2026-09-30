# Problem discovery research — 2026-09-24

Four parallel web-research passes (hobby pains via Reddit archive, vendor/shop pains, search demand + viral formats, "big app × small segment" formula). Evidence is directional: no measured keyword volumes, Reddit post bodies only (no comments), vendor quotes thin.

## The problem

**Nobody knows a fair price at the moment of a deal.** Both sides of a card-show transaction feel it:

- **Vendor (buyer):** price a stack fast, get the printing right (reverse vs regular can be 10x), make a %-of-market offer the seller will accept, keep a record. Today: scan one-by-one in TCGplayer/Collectr, % math in their head, re-key everything after the show. "Pricing is the most annoying part."
- **Seller / newcomer / "found my old binder":** doesn't know what they hold or what a fair offer is; accepts the LCS lowball or asks Reddit after the fact ("did I get cooked?"). ~345 inherited/old-cards posts, ~75 net-proceeds posts, ~70 "which price is real" posts in the sample.
- Price sources disagree (same 25 cards: $17k–$27.5k across four methods), so every deal is a negotiation over which number counts.

## Positioning

"Square POS + CoinSnap for card-show vendors." Scan-and-price for a smaller segment that pays. Consumer "PictureThis for Pokémon" is saturated (10+ "best scanner app 2026" SEO roundups, several free scanners); Collectr owns the portfolio play. Vendor apps (Vendilot $20/mo, DeckTradr ~$30/mo, CollectorBased $99/yr, Nanab, CardOps, Double Holo beta) are small and none has won; all are inventory/POS-first, none leads with variant accuracy.

## Killer features (1–2)

1. **Stack → offer.** Rapid/binder-page scan with the correct printing, tiered buy % auto-applied (chase 70–80 / mid 60–70 / bulk 40–50, vendor-configurable), running total, bulk by count.
2. **Transparent offer receipt (QR).** Seller sees each card, source-labeled price, and the offer %. Builds trust at the table, and every seller — the anxious "what's my binder worth" crowd — becomes an install. This is the growth loop.

Follow-on: bought log → cost basis → per-show P&L; export into shop inventory (kills the re-key).

Pricing to test: free ~50 scans/show, Pro $19.99–29.99/mo or $199/yr, $9.99 weekend show pass.

## Marketing

- Content format: Vendor POV at a show ("someone brought me this binder, let's price it") — the app is naturally on screen, and it's how vendors discover tools (YouTube Vendor POV vlogs).
- Keyword gaps: "what app do vendors use", "card show buy percentage", "what do vendors pay for pokemon cards", "old pokemon cards worth", Japanese card value. Avoid the "pokemon card scanner" head term.

## Don't

- Promise fake detection (most-discussed pain, ~380 posts, but a front photo can't authenticate — liability).
- Lead with portfolio tracking (Collectr's lane).
- Chase scalper/repack rage (loudest, unsolvable by a scanner).

## Also noted (cheap retention, not the wedge)

- Per-Pokémon master-set checklists incl. promos ("every Mew card").
- Non-EN/JP coverage (Chinese/Korean/French) — every app is "Japanese only".
- Grade verdict: scan → raw vs PSA 9/10 spread vs fees. Competitors are hand-entry calculators.

## Validate before building

1. Interview ~10 vendors at the next show / vendor Discords: how they price buys, time per binder, last overpay. Stop if they don't call it painful.
2. Film 3–5 Vendor POV clips; watch for "what app is that?" comments.
3. PostHog: find users with 100+ scans on show days — those are the customers; contact them.
4. Apple Search Ads on the vendor keywords above.

## Key sources

- Collectr Pro https://getcollectr.com/pro · Vendilot https://vendilot.com/ · DeckTradr Pro https://www.decktradr.com/pro · CollectorBased https://www.collectorbased.com/ · Double Holo Vendor Hub https://doubleholo.com/vendor-hub
- Vendor workflow guide https://cardvalue.app/guides/pokemon-trade-show-vendor-guide · Elite Fourum vendor thread https://www.elitefourum.com/t/any-card-show-vendors-here-would-love-to-pick-your-brain/54638
- Price-source spread https://tcginvest.io/blog/pokemon-collection-value-different-apps
- Identifier-app category $27M/mo https://appfigures.com/resources/insights/20250509?f=1
- Reddit: https://reddit.com/r/PokemonTCG/comments/1uyua5h · https://reddit.com/r/PokeInvesting/comments/1t5nim6 · https://reddit.com/r/tcgcollecting/comments/1vlj7aj · https://reddit.com/r/PokeInvesting/comments/1t79yc3
