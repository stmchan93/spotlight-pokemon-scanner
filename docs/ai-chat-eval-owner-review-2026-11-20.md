# Ask Ekalight: owner's review of the first eval run (2026-11-20)

Source: the owner's review of eval run 1 (labels L001–L030 from `--export-labels`). This file is the SPEC for the next round: reference answers, grading criteria, and product decisions. Where it conflicts with `docs/ai-chat-contracts-2026-11-17.md`, THIS FILE WINS.

## Update 2026-11-20: never reveal history coverage (owner decision)

Answers must NEVER say how much price history Ekalight has: no "only 30-61 days of history", "the low covers that stretch", "history starts in August", "since August" as a coverage caveat, "short-lived spikes", "not a full year", "the closest window I can check". This overrides every item below that asks the answer to state coverage (decision 5's L020 wording, L011, L020 "explain the available date range"). Answers must stay true: never claim an uncovered window ("1-year low", "over the past year") when the history doesn't cover it; use neutral wording ("near its recent low", "at its lowest recorded price", "recently", "lately"). Dated moves ("jumped on Oct 28") are fine.

How it's enforced: the model gets `window_label` ("past year" when covered, else "recently") instead of `days_covered` / `covers_full_*` / `first_date` / `range_start`; a code backstop (`length_guard`) rewrites or drops coverage sentences; tile sparklines are labelled only with a range their series covers (1y/90d/30d/7d) and appear on tiles from every market/movers tool (`get_market_trends`, `find_movers`, `find_price_lows`, `find_new_highs`). Eval: default banned pattern `history_coverage`, automatic `no_uncovered_window_claim` check (replaces `history_range_stated`), and the L011/L020/movers rubrics were updated.

## Update 2026-11-20: no tables; bullet per card; tray named; no data-source caveats (owner decision)

From "What are these worth in a PSA 10?" asked from the scanner tray. The app renders only **bold** and "- " bullets, so a markdown table showed raw pipes.
- **No tables, ever.** Grading answers use one bullet per card: "- **Kyogre-EX** (Dark Explorers 104/108): raw $504.48 → PSA 10 $1,450 (+$945.52, +187%)"; no comp: "- **Lugia** (HGSS02): raw $485.99 · no recent PSA 10 sale". Keep the short grading-fees sentence. This replaces the L026 table template below.
- **Name the scan tray.** With scanner context, an answer about "these/this/them" says where the cards come from: "Of the N cards in your scan tray…" or "This scanned card…". The model's preamble reads "The user's scan tray contains: …".
- **No data-source caveats**: no "market estimates", "based on recorded sales", "estimates based on", "data may…", "according to our data", "Ekalight's data shows". "Not a prediction" and grading-fees lines stay.

How it's enforced: prompt rules + final checks; a code backstop (`length_guard.tables_to_bullets`, no extra call) turns any table into "- **col1**: Header2 col2 · …" bullets; caveat phrases join the internal-wording backstop (rewrite, else drop the sentence); `grading_upside`'s basis prose no longer says "estimate". Eval: default banned patterns `markdown_table` and `data_source_caveat`; automatic `scan_tray_named` check on scanner turns whose question says these/this/them (skipped for action turns; opt out with `scan_tray_named: false`); L026 now forbids pipes and its reference is the bullet format.

## Product decisions (cross-cutting)

1. **Tiles = the cards the answer is about**, not every card a tool returned. Check the final rendered card IDs (and language, raw condition, grader, grade where relevant). A search can return 8 candidates while the answer shows only the 1 that answers the question. Every card named in the text must appear as a tile, and tiles must not show cards the answer isn't about. Multiple candidate tiles are right only when the assistant is asking the user to choose (e.g. "How much is Charizard?" → which printing?).
2. **Direct add when fully specified** (L007): if the user gives an explicit add action, an exact printing, a quantity and a condition, add it directly and report success only after the write succeeds; offer **Undo**; retries must not double-add (idempotent). Ask for clarification on material ambiguity (multiple matching printings). **Batch adds or adds with inferred conditions** (e.g. "add the cards in my scan tray") still use the confirm flow (L028). Supersedes the 11/17 "every write needs Confirm" rule for this one case.
3. **"Card" means a single** (L009, L015): when the user asks about "cards", filter sealed product out **before ranking and rendering**. The product default stays "any" for other wording (sealed questions, browsing).
4. **"Most expensive" shows a raw leader and a graded leader** when both datasets have results (L015), using the same rule for every game. Graded prices need a **trusted-price flag**; obvious placeholders (e.g. a $999,999 PSA 10 Kyogre ex) must be excluded, so the model can ground the word "verified" (L010).
5. **History windows are honest**: never imply a full-year return unless the tool supplies the year-ago price (L020), and never remark on how much history exists (see the 2026-11-20 update). Call market-price highs "market-price highs" unless they're completed sales (L027).
6. **Same artwork, one tile**: if multiple printings share the same artwork, show one by default so the user sees more distinct scenes (L003). Examples named in the text must come from the final displayed tiles.
7. **Charts**: for a resolved card, show one tile plus its price-history chart, tied to the same card ID and price variant (L004, L016, L020). For "near their lows" results, the drop is why the card was surfaced, so show a small sparkline per tile or the chart on tap, with the period labelled (L011).

## Per-case reference answers and criteria

### L001 What's my collection worth?
Reference: "Your collection is worth about $6,522.94 across 81 holdings at current market prices. It's down $708.06 over the past 30 days, mostly because the sealed Legacy Booster Display Case fell about 43%."
- First sentence gives the collection value in USD and matches the collection tool's total.
- Any 30-day change or explanation matches the tool data.
- Leave out the unpriced-holdings note for this case.
- Tiles: a collection value summary; if tiles are shown, label them **Top holdings by value**, ranked by price × quantity. (Run 1 showed the same eight unsorted tiles as L017.)
- **Data check:** $708.06 is ~9.8% of the implied starting value if the collection is now $6,522.94, but the tool said −18.69%. Find which holdings or starting balance the % uses, and fix it or make it consistent.

### L002 What am I missing from Surging Sparks?
Reference: "You're missing 278 of the 279 Surging Sparks cards. You own 1."
- State the missing count; use "at least" if the tool marks it a lower bound.
- Leave out cheapest-card commentary.
- If the completion cost is unavailable, leave it out.
- Tiles: **Chase cards you're missing**: filter out owned, rank by a popularity signal if one exists, else market price labelled **Highest-value cards you're missing**. (Not the cheapest $0.05 commons.)
- Completion cost lives in the data layer for "what does it cost to finish": try an exact-match fallback price source (same printing, language, variant, condition). If cards are still unpriced, give a labelled subtotal with coverage ("$X for Y of 278 missing cards"). Give a full estimate only when every missing card has a usable price.

### L003 Show me cozy cards with Pokémon sleeping
Reference: "Here are some cozy cards featuring sleeping Pokémon, including Cyndaquil and Meowth."
- One or two short sentences.
- The visible cards plausibly match the requested artwork.
- Any Pokémon named in the text appears in the visible tiles (run 1 named Swinub, which wasn't a tile).
- Leave out print-language and pagination commentary unless asked.
- Rank by artwork relevance; dedupe printings that share artwork.

### L004 Show Kyogre-EX's price history
Reference: "The raw Near Mint Holofoil market price for Kyogre-EX (Dark Explorers, #104/108) held near $319 from late August through late October, then jumped to about $504 and was at $504.48 on Nov 18."
- Identify the exact printing and price condition up front.
- Summarize the main move in about one sentence using the price-history data.
- Leave out the graded-history aside.
- Pass conditions: **one** matching card tile + the chart, same card ID and variant (run 1 showed five Kyogre printings).

### L005 Japanese Charizard counterpart
Reference: "The Japanese counterpart is Charizard ex from Pokémon Card 151 (SV2a), #201/165. Its market price is $370.86 USD." Pass if it identifies the linked Japanese printing with its USD price; one tile for JP #201/165.

### L006 Watchlist and target prices
Reference: "You have 17 cards on your Watchlist, and none has a target price set. Your two highest-priced cards are Oshawott (White Flare) at $67.84 and Torchic (Shiny Collection) at $39.00."
- Count and target status match the full Watchlist; any ranking uses the full result.
- Sort priced cards by market price; when targets exist, put cards at or nearest their target first.
- Show up to 8 as a compact preview, with **View all 17** if the UI supports it.

### L007 Add two Near Mint Charizard ex
Reference after a successful write: "Added 2 Near Mint copies of Charizard ex (151, #199/165) to your collection."
- Collection quantity increases by exactly two; retrying the same request can't add two more; success only after the write succeeds; Undo offered.
- One tile for #199/165 with quantity two.

### L008 Ocean poem — keep the existing refusal and criterion. No tiles.

### L009 Most expensive One Piece card
Reference: "The most expensive One Piece single card in Ekalight is Rocks.D.Xebec (OP17-118, The World's Strongest Warriors) at about $6,100 on TCGplayer."
- Card and USD price match the highest-priced eligible single. Show only Rocks.D.Xebec. Sealed filtered out before ranking and rendering.

### L010 Most expensive PSA 10s
Reference: "The top verified PSA 10 is the 1st Edition Shadowless Base Set Charizard at about $409,540, with the Legendary Collection Reverse Holofoil Gengar close behind at about $408,000."
- Two PSA 10 tiles matching those exact variants. Data supports both prices and the ranking.
- Graded prices need a trusted-price flag or an explicit exclusion for the $999,999 Kyogre record.

### L011 Undervalued cards
Reference: "Pikachu ex, Espeon ex, and Umbreon ex from the Mega Evolution Promo set are all sitting at or near their lows after falling 67% to 95% from their highs. This is a snapshot of past prices, not a prediction."
- Three tiles (Pikachu ex #107, Espeon ex #108, Umbreon ex #110), each passing the near-low filter; drops match the history; no prediction.
- Sparkline per tile (or chart on tap) with the period labelled (only a period the series covers). No remark on how much history the cards have (2026-11-20 update).

### L012 Most valuable scanned card
Reference (scan tray as source): "Of the three cards in your scan tray, Charizard ex (151, #199/165) is worth the most at $287.93. The Obsidian Flames Charizard ex is $84.09, and the Kyogre-EX is $19.39."
- Seed the tray with those three printings; assert the comparison uses their IDs; names the tray; picks the highest; no graded aside.

### L013 What's a SIR?
Reference: "Charizard ex from Pokémon 151 (#199/165) is an example of a Special Illustration Rare, or SIR. It's a high-rarity Pokémon card with a full-card illustration, often featuring a detailed scene."
- Expands SIR correctly; the example is catalogued as that rarity; one tile for the example.

### L014 How much is Charizard? — keep: multiple candidate tiles; ask which set/number.

### L015 Most expensive Lorcana cards
Reference: "Among graded Lorcana cards in Ekalight, Mickey Mouse (Challenge Promos C1 #5, CGC 9.5 Cold Foil) is listed at $38,000, followed by Elsa's Ice Palace (C1 #7, PSA 10) at $35,000. Among raw cards, Mickey Mouse (Fabled #242) leads at about $4,167, followed by Buzz Lightyear (Wilds Unknown #241) at about $3,593."
- Same ranking rule for every game: a raw leader and a graded leader when both exist; one result is enough when only one category exists (e.g. One Piece has no graded prices; say so if the trace confirms it).
- Each named price matches its raw or graded result; four tiles (two graded variants + two raw cards cited); sealed excluded.

### L016 Why did Charizard ex #199 go up?
- With history: lead with the actual move and dates; if the chart doesn't show a rise, say what it shows; give a cause only with evidence.
- Fallback: "I couldn't verify a recent price increase for Charizard ex (151, #199/165). Its current market price is $287.93."
- One Charizard tile + chart when data exists. Run 1 recorded a **failed trend lookup** here while L020 got history for the same printing: investigate. Test both the success and the fallback so a missing-history response can't pass the success case.

### L017 Biggest collection gainers
Reference: "Your biggest gainers over the past 30 days were Kyogre-EX (+$18.49, +3.8%) and Snorlax (+$11.79, +7.2%) by dollar gain. Gyarados gained 14%."
- Gains match the tool; ranking clearly distinguishes dollars from percentages; only those three cards; lead with gainers; omit the overall collection decline.

### L018 Cost to finish 151
Template: "You're missing 238 of 241 English 151 cards. I don't have a reliable total for all 238, but here are three of the highest-value cards you're missing: [card and USD price], [card and USD price], and [card and USD price]."
- Run 1's tiles were **Japanese** 151 cards: resolve "151" to the English set. Count matches the English set; each named card is missing and priced; no unsupported full-cost claim; exactly the three named tiles.

### L019 Rainy night art
Reference: "I found a mix of cards with rain or nighttime artwork, though I couldn't confirm that every scene shows both. Rain Castform, Umbreon (Dark Explorers), and Night Pokémon Center are the closest matches, and the selection includes a Japanese print."
- Those three tiles; art-tag matching stays internal; displayed artwork plausibly matches; text reflects match quality.

### L020 Charizard ex #199 over the past year
- Keep the recorded summary if history supports it; only #199 tile + chart; ~~explain the available date range~~ (superseded 2026-11-20: say nothing about coverage); don't imply a full-year return (the 31% was April→November) unless the tool supplies the year-ago price.

### L021 English Charizard counterpart — keep; two tiles (source + counterpart).

### L022 Wishlist — keep; same preview limit + full-list entry as L006.

### L023 Base Set Pikachu add
- The recorded lookup failed to find Base Set #58: **verify the catalog**. If the printing exists, follow L007's direct-add rules. For an unresolved lookup: no write, ask which printing, render only the two alternatives.

### L024 Tokyo weather — keep the refusal. No tiles.

### L025 One Piece follow-up — keep; show only Rocks.D.Xebec and Nami; winner consistent with L009 unless data changed (and the answer explains it).

### L026 Worth grading
Template: "Your strongest grading candidates are Kyogre-EX, Lugia, and Teammates." Then one bullet per card (superseded the original table, see the 2026-11-20 update above): "- **Kyogre-EX** (Dark Explorers 104/108): raw $504.48 → PSA 10 $1,450 (+$945.52, +187%)".
- Gross premium = PSA 10 price − raw price; % = difference ÷ raw price. Show net premium too if fees/shipping are available. If a comp is missing, say so for that card. Three candidate tiles. The eval needs PSA 10 comp inputs before it can require the dollar/percent gains.

### L027 Recent new highs
Reference (if completed sales): "Recent Pokémon cards with new high sales include Base Set 2 Mewtwo (Holofoil) at $164.96 and Majestic Dawn Garchomp LV.X at $379.00."
- Show only Mewtwo and Garchomp (run 1 named Garchomp without a tile; assert both IDs). If it's market-price history, call them **market-price highs**. The % from the low and its window belong in the chart/supporting detail.

### L028 Add cards from the scan tray — keep the two-card confirmation flow; two matching tiles; both proposals match the tray; no write before confirmation.

### L029 PSA vs CGC — keep. No tiles.

### L030 Add Pikachu — keep the clarification; ask which Pikachu and wait before proposing/writing; candidate tiles help the user choose.
