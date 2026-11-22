# Ask Ekalight: marketable assistant features plan (2026-11-21)

Status: PLAN, nothing built. Staging only: AI features stay off production (prod OTAs ship without the assistant; ask the owner before any prod step).

## 1. Summary and build order

The assistant can already look up any card's USD price, its price history, PSA 10 comps for up to 3 cards, the user's holdings with gain since purchase, and the cards in the scan tray. It can also propose adds, quantity or condition edits and watches for the user to confirm. That covers about half of each approved feature. The common missing pieces are:

- **Server-side math tools** that return a finished verdict (deal %, trade gap, grading net). Then the model only explains numbers and never does arithmetic itself.
- **A verdict card in the chat UI.** Today the chat can only show text, card tiles, a price chart and Confirm cards.
- **A way to attach a scan mid-chat.** Today the scan tray goes with the first question of a thread only, and there is no photo button in the composer.
- **A numeric eval check**, so that "math within ±1%" is tested by code and not only by the LLM judge.

**Recommended order:**

1. **"Should I grade this?"** (S–M, ~3 days). About 70% is built: `grading_upside`, its prompt rule and an eval case already exist. It needs a fee table, PSA 9/8 and BGS/CGC rows, and a net figure. It is the cheapest win, and it builds the verdict card and the numeric eval check that features 2 and 3 reuse.
2. **"Is this a good deal?"** (M, ~4–5 days). This is the strongest show-floor hook: scan a card, type the asking price, get a verdict. It reuses the tray context plus one new tool, and it adds the "attach a scan" button to the composer.
3. **Trade checker** (M, ~4–6 days). The same verdict card and a new tool. Done in chat, it costs much less than the standalone trade screen in the July spec, because two lists of cards can come from the tray, from names, or from both.
4. **Collection actions by chat** (M, ~3–4 days). Adds, quantity and condition edits, watches and "worth now vs when I bought it" already work. Missing: remove, move between collections, create a collection, and add to a named collection.
5. **Vendor price tag** (L, ~8–12 days). This is mostly scanner and web work, not chat. It also has the most open owner decisions (public QR page, buy-% tiers, Bought log), and the September research said to validate it with vendors before building. The tray already has a display-only "% OF MARKET" total, which is the seed. Build it last, or split it out as a non-AI feature that could reach prod.

**Biggest gaps across all five:** no centering measurement anywhere in the code; no gem-rate data (it went away with PokemonPriceTracker on 10/14); graded sold comps are Scrydex-only (at most ~25 rows, thin for many cards); no grading-fee source; the assistant's 4-tool-round cap (config.py:57) is tight for multi-card trades; and there is no public web page today for the vendor QR handoff.

---

## 2. Features

### 2.1 "Is this a good deal?"

**What the user sees.** The user scans a card or a 3x3 binder page and asks with a price. The answer leads with a verdict, shows the market price, the asking price as a % of market and a short price trend, and ends with one line to say in the haggle.

> **User** (scan tray: Charizard ex 151 #199): *They want $250 for this, good deal?*
> **Ekalight:** **Fair.** $250 is **87% of market** ($287.93) for this scanned Charizard ex (151 #199). It has drifted down 6% in 30 days, so ~$240 is a reasonable counter.
> [Verdict card: GOOD BUY / FAIR / WALK AWAY · ask $250 · market $287.93 · 87% · 30-day sparkline]

**Have vs Need**

| Have | Need |
|---|---|
| Scan tray sent as context; the model sees name, set, number, USD price and card_id per card (`assistant/tools.py:2057`, `service.py:120-141`) | A way to attach a scan mid-thread. Today the context goes with the first question only (`use-assistant-chat.ts:71-74, 140-142`) |
| Binder Multi-Scan (3x3 only) with per-pocket identification and printing choice (`scanner-normalized-target.ts:184-186`, `binder-page-review.tsx`) | A tool that takes an asking price (total or per card) and returns a verdict per card and for the lot |
| USD raw price with the TCGplayer main lane (`tools.py:223-251`); the condition matrix exists for LP/MP | Asking-price parsing. `question_target_usd` (`engine.py:412`) only fires on watch wording |
| `get_price_history` with summary and chart (`tools.py:2588`) | A prompt rule. Line 72 currently sends "good buy" to market trends, which is wrong when a card and a price are given |
| Graded comps from cache (`tools.py:2093` `_graded_comp`) for slabs | A verdict card component in chat |
| Yen is blocked at the data layer (`usd_price` returns None for non-USD) and flagged (`flags.py:41`) | A numeric eval check |

**New tool: `evaluate_deal`**
- Inputs: one or more card ids (from the tray or a search), each with an optional condition (default NM) or grader + grade; the asking price, either as a lot total or per card; and the user's side (buying, the default, or selling).
- Outputs: for each card, the market price, the asking price (a lot total is split pro-rata by market price), asking as a % of market, the 30-day move, the age of the price and a liquidity hint (sale count for slabs). For the lot: total market, total asking, overall % and a verdict of `good_buy`, `fair`, `walk_away` or `unknown`. Bands (resolved, see section 5 #2): buying ≤90% good buy, 90–105% fair, over 105% `walk_away` (worded "above market"); selling to a vendor ≥80% strong, 65–80% typical, under 65% low. It returns `unknown` with a reason when any card lacks a USD price; the model must then say "no price" and never guess.

**App UI**
- Composer: a **Scan** button (camera glyph) left of the field. It opens the scanner in a "return to chat" mode, either single or Multi-Scan. Confirmed cards come back as an attachment chip above the field ("3 cards attached"), and the next message carries them as `context.card_ids`. This needs `contextSentRef` to allow a new attachment on any turn.
- A **verdict card** under the answer: the verdict pill, ask vs market and the %. For a binder page, one compact row per card (reusing `assistant-card-row.tsx`) plus a lot total.
- Empty-state chip when opened with one card: "Is $X a good price for this?" (the field pre-fills with "$").

**Data and cost**
- 0 Scrydex credits. The assistant runs on `ReadOnlySpotlightService`, which turns off live pricing and Scrydex refresh (`readonly_service.py:25-32`). All prices come from the daily sync tables.
- Slab comps come only from what is already cached (`slab_recent_sales_cache`, 24h freshness, `server.py:597`). The assistant never triggers a listings call.
- LLM cost: a single-turn answer is about $0.003–0.01 on Haiku 5.5; the eval budget is $0.02 per turn.

**Risks and honest limits**
- The verdict is only as right as the identified printing and condition. Reverse vs regular can be 10x. The verdict card must show the printing and condition it assumed, and a tap must be able to change them.
- Market price is daily, not live. Show the price's age when it is more than 3 days old.
- Raw "recent solds" for raw cards are not in the assistant's data. Use the 30-day trend for raw cards and cached graded comps for slabs only.
- Japanese cards without a USD price return `unknown`, never a yen figure.
- Never frame it as a prediction or as advice; keep the existing "not a prediction" rule.

**Effort: M (4–5 days).** Tool, prompt rule and tests: 1.5 days. Scan attach and return-to-chat: 1.5 days. Verdict card: 1 day. Eval cases: 0.5 day.

### 2.2 Trade checker

**What the user sees.** The user lists two sides by scan, by name, or by mixing both. The answer gives each side's total, the gap, a verdict and one fix.

> **User:** *Trade check: my Moonbreon (Evolving Skies 215) for their Charizard ex 151 #199 + Kyogre-EX Dark Explorers*
> **Ekalight:** **Uneven: you give up $X more (Y%).** Your side $A · their side $B. To even it out, ask for ~$X cash, or a card around that value.
> [Trade card: YOUR SIDE / THEIR SIDE columns with totals, the gap bar and the fairness band]

**Have vs Need**

| Have | Need |
|---|---|
| `search_cards` resolves names, with ambiguity and default-printing hints (`assistant/tools.py:1380-1443`) | A two-sided input. Today the tray context is one undifferentiated list |
| Prices for tray cards and holdings; `get_my_collection` lets "my side" come from owned cards | A `check_trade` tool that resolves and totals both sides in one call, so names don't burn the 4-round cap (`config.py:57`) |
| A trade spec with a neutral band ("within ~5% = roughly even") and the 1–2-week warning on the dual-tray refactor (`grading-advisor-and-trade-analyzer-spec-2026-07-16.md`) | A trade card in the UI; a way to tag tray cards "theirs" vs "mine" |
| The July spec's Trade Analyzer screen is not built (no `trade` route under `app/(stack)`) | A balancing suggestion (cash, or a near-value card from the user's own collection) |

**New tool: `check_trade`**
- Inputs: two lists, mine and theirs. Each item is a card id or a free-text name, plus an optional condition, grader + grade, and quantity.
- Outputs: each item resolved (or marked ambiguous with candidates), each side's total, the gap in $ and %, and a verdict: `fair` (within 5%), `slightly_uneven` (5–15%) or `uneven` (over 15%). Bands resolved in section 5 #3. The balancing fix is the cash amount, plus up to 2 cards from the user's own collection priced within ±15% of the gap, only when "my side" is short of value. A side with an unpriced card returns `unknown` for that side's total, with "N cards unpriced" stated.

**App UI**
- In the scanner, a long-press or row menu "Mark as theirs" before tapping Ask. Simpler v1: two scans in a row; the chat asks "Is this your side or theirs?" and keeps the last attachment for each side.
- A trade card under the answer: two columns, totals, a gap bar and the band line. Tapping a row opens the card page.
- Tone decided in July: numbers plus a neutral band. Never "bad trade" or "rip-off".

**Data and cost.** 0 Scrydex credits (DB only). One tool call instead of N searches keeps a turn at about $0.005–0.015.

**Risks and honest limits**
- Name resolution will hit "which Charizard?" often. The tool must return candidates, and the model must ask, as it does today.
- Slabs: comps are thin for many cards. Mark low-sale slab prices "few sales" in the trade card.
- Condition defaults to NM for both sides, which flatters played cards. Show "NM assumed" on the card.
- Trade value is not the same as buy price. Show market vs market only; no vendor % in this feature.

**Effort: M (4–6 days).** Tool and resolution: 2 days. Two-sided context and the mark-theirs UI: 1.5–2 days. Trade card: 1 day. Evals: 0.5 day.

### 2.3 "Should I grade this?"

**What the user sees.** The answer gives, for each grade, the grade's price minus the raw price minus fees and shipping, and a one-line recommendation.

> **User** (one scanned card): *Should I grade this?*
> **Ekalight:** **Only if you expect a 10.** This scanned Kyogre-EX is $504 raw. A PSA 10 nets about **+$880** after ~$45 fee and ~$20 shipping, a PSA 9 about **+$40**, and a PSA 8 loses money. Grading takes weeks.
> [Grading card: rows for PSA 10/9/8, then BGS and CGC if comps exist · net per grade · break-even grade · optional "rough centering 55/45"]

**Have vs Need**

| Have | Need |
|---|---|
| `grading_upside`: raw vs a PSA 10 comp (cached eBay-sold average, else the Scrydex graded market) with `gross_premium` (`tools.py:2006-2075`, `_graded_comp` 2093) | The assistant schema exposes only `card_ids`. `grader`/`grade` exist in `CollectionTools.grading_upside` but are not in the tool's JSON schema (`assistant/tools.py:366-378`); results are capped at 3 cards |
| A prompt rule and bullet format for "worth grading" and for "what are these worth in PSA 10" on the tray (`engine.py:61-62`) | Several grades and graders per card (PSA 10/9/8, BGS 9.5/9, CGC 10/9.5), within the 3-card cap |
| Eval case `worth_grading` with seeded PSA 10 sales fixtures (`cases.yaml:625-667`) | A grading fee and shipping table (none in code; the July spec suggested a client constant of $25) |
| Graded prices exist only for games with `has_graded_pricing` (Pokémon, Lorcana; `catalog_tools.py:2122-2218, 2414`) | Net = comp − raw − fee − shipping; a break-even grade; a recommendation band |
| Pinch-zoom on the card hero for manual centering checks (`card-detail-hero.tsx:37`) | **Centering: nothing exists** (no code measures borders) |
| — | **Gem rate: gone.** It came from PokemonPriceTracker population data, removed 10/14, so a probability-weighted EV is not possible today |

**New tool: `grading_value`** (replaces or extends `grading_upside`)
- Inputs: card ids (1–3); optional graders (default PSA); optional declared condition; optional `centering` (left/right and top/bottom ratios) from the scan.
- Outputs, per card: the raw price; for each grade, the comp price, its source (sold vs market), sale count and as-of date; fee and shipping used (with the fee table's as-of date); net per grade; the break-even grade (the lowest grade with net > 0); and a recommendation: `grade_if_confident_10`, `worth_grading`, `not_worth_it` or `no_comps`. With centering, add `centering_cap`: the best grade it plausibly allows (for example, worse than 60/40 caps at PSA 9), labeled rough.
- No EV percentage without gem-rate data. Show per-grade scenarios and the break-even grade instead. That is honest and still clear.

**Centering (v2 of this feature, separate)**
- The scanner already produces a rectified `normalized_target` card crop on device. Border widths could be measured on that crop on device, without uploading anything new. Scan artifacts stay private; the assistant would receive only the four ratios.
- Limits: phone perspective, sleeves and top-loaders, and full-art or borderless cards (no border to measure). Ship it as "rough centering", only for bordered cards, and only as a cap, never as a grade prediction. This is not a scanner change: it does not touch matching, top-K or training, so the scanner do-nots are not involved.

**App UI.** A grading card under the answer: one row per grade with comp and net (green or red), a fee line ("~$45 PSA fee + ~$20 shipping, as of <date>"), and the break-even grade. Optional centering chip.

**Data and cost**
- 0 credits from chat (cached comps and graded cells only).
- If the owner wants fresher comps: one Scrydex listings call per card + grader + grade per 24h (`card_recent_sales`, `server.py:18992`), and only in the main server. 3 graders × 3 grades = up to 9 calls per cold card. **Recommendation:** never warm from chat. Comps are warmed when someone opens the card page's graded view, as today.
- eBay Browse currency reconciliation runs only on that refresh path, with free app-token calls (`recent_sales.py:238`).

**Risks and honest limits**
- Graded comps are thin: Scrydex-only since PokemonPriceTracker was removed, at most ~25 rows per card + grade. Many cards have no PSA 8 or BGS comp, so say "no recent sale" per grade.
- Foreign-currency rows Scrydex mislabels as USD can still slip through when eBay can't vouch for them.
- Fees change often (PSA tiers are repriced several times a year). The table needs an owner and an as-of date.
- Phone-photo centering is approximate. Never present it as a grade.

**Effort: S–M (~3 days)** without centering: tool and fee table 1 day, card UI 1 day, prompt and eval 1 day. **Centering: M (+3–4 days)**, measured on device, bordered cards only.

### 2.4 Collection actions by chat

**What the user sees.**

> **User:** *Move my two Umbreon VMAX to my "Grading pile" collection.*
> **Ekalight:** Ready to move 2× Umbreon VMAX (Evolving Skies 215) to **Grading pile**. [Confirm]
>
> **User:** *What's my Kyogre-EX worth now vs when I bought it?*
> **Ekalight:** **Up $154 (+44%).** You paid $350; it's $504.48 now.

**Have vs Need**

| Have | Need |
|---|---|
| In-app writes: `propose_add_to_collection` (takes `collection_id`), `add_to_collection_now` (one fully specified add, undoable), `propose_update_holding` (quantity at least 1, condition), `propose_watch_card` (`assistant/tools.py:393-475`; dispatcher at 1508-1524) | **Remove:** no proposal tool. The prompt says "can't delete" (`engine.py:69`), although the service has `delete_deck_entry` (`server.py:10980`) |
| Confirm cards and an action runner in RN for 3 types (`assistant-action-runner.ts:227-233`) | **Move between collections:** no backend method or route moves a holding today (the deck-entry routes at `server.py:30371-30582` have no move) |
| `get_my_collection` returns `gain_usd` with `gain_basis` = cost basis, or market change since added (`tools.py:1103-1128`); sorting by `gain_desc` exists | **Create a collection:** the service has `create_collection` (`server.py:23508`) but there is no assistant tool |
| External-MCP write tools gated by "Let AI assistants edit my collection" (`write_tools.py:331-343`, `user_ai_settings.allow_mcp_edits`); no delete tool by design | **A way to name collections.** The model has no list of the user's collections and ids, so "add to my Binder" can't resolve |

**Important finding about the toggle.** "Let AI assistants edit my collection" gates only the **external** MCP tools (Claude or ChatGPT connectors: `add_to_collection`, `update_holding`, `watch_card`; `policy.py:41`). The in-app assistant does not check it. In-app writes are safe because each one needs a Confirm tap, except the one-card direct add, which has an Undo. **Recommendation:** keep it that way for new in-app actions (propose, then Confirm). Use the toggle only if these actions are later exposed to external MCP. Remove must always need Confirm, including over MCP.

**New tools**
- `list_my_collections`: the user's collections (id, name, hidden, card count). Read-only.
- `propose_remove_holding`: holding id and quantity to remove (all or some). Confirm card copy: "Remove 1 of 2". Uses the existing delete or quantity paths.
- `propose_move_holding`: holding id, target collection id, and quantity. Needs a new backend method that sets `collection_id`, or splits the holding when moving only some copies.
- `propose_create_collection`: a name, and optionally holdings to move into it once it's created.
- "Worth now vs bought": no new tool. Add a prompt rule that uses `get_card` my_holdings or `get_my_collection` with `gain_usd`/`gain_basis`, and says "since you added it" (not "since you bought it") when `gain_basis` is `since_added`.

**App UI.** New Confirm-card variants (remove in red, move, create). The undo pattern from direct add can apply to move and create; remove needs Confirm and also offers Undo for a short window.

**Data and cost.** DB only, 0 credits.

**Risks.** Deleting the wrong printing or condition. The confirm card must show the exact holding (printing, condition or grade, collection). Hidden collections are excluded from totals; say so when moving into one.

**Effort: M (3–4 days).** Move backend method and route: 1 day. 4 tools and prompt rules: 1 day. RN confirm variants and runner: 1 day. Evals: 0.5 day.

### 2.5 Vendor price tag

**What the user sees.** The vendor sets "I buy at 70% raw / 80% slabs / 40% bulk" once. Each scanned row then shows **market $X → my offer $Y**, with a running total. **Send to seller** shows a QR code. The seller scans it with their own phone and sees each card, its market price, the vendor's offer and the vendor's booth name. If they accept, the vendor taps **Bought** and the cards go to a "Bought" log with cost basis = the offer.

Chat tie-in (secondary; vendors work in the scanner, not chat):

> **Vendor:** *What should I offer for these at 70%?*
> **Ekalight:** **$412 total** for the 9 cards in your scan tray (market $588). Top card: Charizard ex 151 #199, $287.93 → $201.55.

**Have vs Need**

| Have | Need |
|---|---|
| Tray "% OF MARKET" control on the tray **total** (presets 65–90% plus custom), display-only, cleared with the tray (`scanner-screen.tsx:1264-1300, 4098-4105, 5126-5140`; `custom-discount-sheet.tsx`) | A saved buy-% profile (tiers: raw, slab, bulk under $X; optionally JP) and a per-row offer |
| Binder Multi-Scan and the printing chip, both important to vendors | An offer snapshot stored server-side (cards, market and offer at that moment) with a share token |
| A buy ledger: `record_buy` with cost basis and `event_kind='buy'` (`server.py:10588-10700`; routes `/api/v1/buys` at 30007); the transactions log (`card-transactions`, `sales-history.tsx`) | A QR page the seller can open without the app (public web), or an in-app page (needs an install) |
| Booth claims per show (social_27/32; `booth-service.ts:94` `claimBooth`) for vendor identity | An "Accept" state and a "Bought" log view (filter the buy ledger by offer and show) |
| Backend can serve HTML (`_write_html`, `server.py:27058`; admin and consent pages) | An optional sell markup (sell price = market × markup) for vendors' own listings |

**New assistant tool: `compute_offer`.** Inputs: card ids (the tray), buy % (or "use my profile"), and an optional per-card override. Outputs: per-card market and offer, the total, and which tier applied. Read-only; the QR and Bought steps stay in scanner UI.

**App and web UI**
- Settings → "Vendor pricing": buy-% tiers and an optional sell markup.
- Tray rows: "MKT $X · OFFER $Y". The total pill becomes "OFFER $Y of $X".
- **Send to seller:** a sheet with a big QR code linking to `https://api.ekalight.com/o/<token>` (or `ekalight.com`). The page shows cards with images, printing, market price labeled "TCGplayer market" (the "source-labeled price" from the September research), the offer and the vendor's handle and booth. An "Open in Ekalight / Save these cards" button is the install funnel. The offer expires (for example after 2h) and the page never shows yen.
- **Bought:** one tap records all accepted rows through `record_buy`, tagged with show and offer id. A "Bought" filter in Transactions provides the per-show P&L seed.

**Data and cost.** 0 Scrydex credits; the page reads the stored snapshot, not live prices. The public page needs rate limiting and unguessable tokens. Card images use existing CDN URLs.

**Risks and honest limits**
- It conflicts in spirit with the booth spec's "No QR signs" decision (`booth-posts-vendor-spec-2026-10-29.md:19`). This is a per-deal receipt, not a sign, but the owner should confirm.
- 11/16 reframe: most show users are attendees, so vendor-only features reach fewer people. The September research said to validate with vendor interviews first.
- A public page shows card images and prices. It must show no personal data beyond the vendor's public handle and booth.
- An offer shown as market % invites "your price is wrong" arguments. Show the printing and condition per row.
- This is not inherently AI. Building it as a scanner feature means it could reach prod independently of the AI gate (owner decision).

**Effort: L (8–12 days).** Buy-% profile and row offers: 2–3 days. Offer snapshot, token and public page: 3–4 days. Bought flow and log filter: 2 days. Chat tool: 0.5 day. QA at a show: 1–2 days.

---

## 3. Eval plan

**How a case works today** (`backend/assistant_eval/`, guide in `docs/ai-chat-eval-2026-11-19.md`):
- A case in `cases.yaml` is one chat thread: `id`, `category`, optional `holdout`, `fixtures` (rows to insert or delete in a **copy** of the DB), and `turns`. Each turn has `ask`, optional `card_ids` (sent as the scanner tray, `source=scanner`), optional `game`, an `expect` block, a `reference` answer and a `rubric`.
- `expect` holds deterministic code checks (`grading.py:49-91`): tools called (`tools_all`/`tools_any`/`tools_none`/`tool_args`), tool results (`tool_result_where`), tiles (`tiles_exact`/`include`/`within`/`named_cards_in_tiles`), text (`must_contain_any`/`must_not_contain`/`max_words`), actions (`expect_action`, `proposed_card_ids`, `expect_no_write`) and cost (`max_cost_usd`).
- Defaults apply to every turn: status ok, at most 80 words, at most $0.02, and banned patterns for yen (`[¥￥]`, `yen|JPY`), tool talk, provider names, tables and data-source caveats (`cases.yaml` `defaults`).
- `rubric` holds yes/no criteria for an LLM judge (skipped with `--no-judge`). A turn passes only if all code checks and judge criteria pass.
- Tools a case names that don't exist yet go in `PLANNED_TOOLS` (`grading.py:45`); the check is then skipped instead of failing.

**What has to be added**
1. **A new expect key, `amounts_match_tool: {tool: <name>, tolerance_pct: 1}`.** Every `$` amount and `%` in the answer must be within ±1% of a number in that tool's result. This turns "math within ±1%" and "no invented prices" into a code check. Today math is judge-only (the `worth_grading` rubric).
2. Use `tool_result_where` to assert the verdict field (for example `verdict: walk_away`).
3. **Stable verdicts without pinning prices:** use extreme asking prices ($1 vs $100,000), so the verdict cannot flip as market prices move. Pin exact numbers only through fixtures on the DB copy (like `worth_grading`).
4. Add the new tools to `PLANNED_TOOLS` until they ship. New categories: `deal`, `trade`, `grading`, `collection_actions`, `vendor`.

**Example questions per feature** (each also gets the defaults: USD only, no yen, no provider names)

| Feature | Question (context) | Must assert |
|---|---|---|
| Deal | "They want $1 for this, good deal?" (tray: sv3pt5-199) | `tools_all: [evaluate_deal]`; verdict `good_buy`; tile = sv3pt5-199; answer names "scanned card"; amounts match the tool |
| Deal | "Is $100,000 fair for these?" (tray: sv3pt5-199, xy5-54) | verdict `walk_away`; lot total = sum of the per-card market prices ±1% |
| Deal | "$250 for a Charizard ex, worth it?" (no tray, ambiguous name) | asks which printing (`ask_which`); no verdict; must not contain "good buy\|fair\|walk away" |
| Deal | "Is $50 good for this?" (tray: a fixture card with no USD price) | verdict `unknown`; must contain "no price"; no `$` amount other than $50 |
| Deal | "Good price at $300 for this PSA 10?" (tray slab) | `tool_args` grader PSA, grade 10; uses the graded comp, not the raw price |
| Trade | "Trade check: my sv3pt5-199 for their bw5-104 + xy5-54" | `check_trade` called once; both totals and the gap match the tool ±1%; the verdict band matches the gap % |
| Trade | "Is this trade fair? mine: these, theirs: Base Set Pikachu" (tray as mine) | the tray goes to "mine"; base1-58 resolved; the trade tiles include all cards |
| Trade | "My Charizard for their Kyogre" | asks which printings; no totals invented |
| Trade | Side with an unpriced card | "N unpriced" stated; no verdict for that side |
| Grading | "Should I grade this?" (tray: bw5-104, fixture PSA 10/9 sales) | `grading_value`; net = comp − raw − fee − ship ±1%; the fee line names the as-of fee; at most 90 words |
| Grading | "Is it worth grading in BGS?" | `tool_args` graders include BGS; says "no recent BGS sale" when comp_missing |
| Grading | "Grade these?" (tray of 3) | 3 bullets; no table; tiles = the 3 tray cards |
| Grading | "What if it gets a 9?" (follow-up turn) | reuses the card; PSA 9 net from the tool |
| Collection | "Move my Kyogre-EX to Grading pile" (fixture collection) | `expect_action: {type: move_holding}`; `expect_no_write: true` (Confirm needed) |
| Collection | "Remove one Pikachu" | `propose_remove_holding`; no write until confirmed; Confirm card shows printing and condition |
| Collection | "What's my Kyogre worth vs what I paid?" (fixture cost basis $350) | gain = value − cost ±1%; says "paid" only when `gain_basis` = cost_basis |
| Collection | "Make a collection called Show stock" | `propose_create_collection`; no write |
| Vendor | "Offer at 70% for these" (tray of 3) | `compute_offer`; each offer = market × 0.70 ±1%; total = sum |
| Vendor | "What do I pay for this at 65%?" (no-price card) | refuses to quote; says no price |
| Vendor | "Use my buy profile" (fixture profile 70/80/40) | the right tier per card (slab 80%, bulk 40%) |

**Worked example case (deal):**

```yaml
- id: deal_walk_away_extreme_ask
  category: deal
  turns:
    - ask: "They want $100,000 for these, good deal?"
      card_ids: [sv3pt5-199, xy5-54]
      expect:
        tools_all: [evaluate_deal]
        tool_args: {evaluate_deal: {asking_total_usd: 100000}}
        tool_result_where:
          - tool: evaluate_deal
            where: {verdict: walk_away}
        amounts_match_tool: {tool: evaluate_deal, tolerance_pct: 1}   # new key
        tiles_within: [sv3pt5-199, xy5-54]
        must_contain_any: ["walk away", "Walk away", "**Walk away"]
        max_words: 80
      reference: "**Walk away.** $100,000 is about 32,000% of market ($307 for the 2 cards in your scan tray)."
      rubric:
        - "Does the first sentence give the verdict?"
        - "Are the market figures the tool's numbers, in USD?"
```

The other features follow the same shape. Grading copies `worth_grading` (fixtures seed `slab_recent_sales` + `slab_recent_sales_cache` for PSA 10 and 9). Collection actions copy `scanner_add_all` (`expect_action` + `expect_no_write`). Trade uses `tool_result_where` on `gap_usd` and `verdict`.

**How to run** (staging VM; makes real Anthropic calls that count toward the daily spend cap):

```bash
# locally, no API calls: validate the case file
cd backend && .venv/bin/python tools/assistant_eval.py --validate
# on the staging box (env loaded as in docs/ai-chat-eval-2026-11-19.md)
.venv/bin/python tools/assistant_eval.py --database-path data/spotlight_scanner.sqlite \
  --user-id <eval user> --db-copy --category deal --category trade --category grading \
  --repeat 3 --majority --out /tmp/eval-features.jsonl --report /tmp/r.md --quiet
```

`--db-copy` is required for fixture and write cases (~20 GB temp copy; check disk). Use `--no-judge` for cheap code-only passes. Keep 1–2 cases per feature as `holdout: true` and never tune prompts against them.

---

## 4. Marketing and demo script

| Feature | 10–20s demo |
|---|---|
| Deal | Show floor, vendor case in frame. Scan a slab, type "they want 250". **WALK AWAY / FAIR** pill appears with "87% of market". Caption: "Never overpay at a card show." |
| Trade | Two hands, two cards on a table. Scan both, mark one "theirs". The trade card animates the gap: "You're giving up $38 — ask for $38 cash." Caption: "Settle the trade in 5 seconds." |
| Grading | A raw card on a mat. Scan, ask "should I grade this?" Rows fill in: PSA 10 +$880, PSA 9 +$40, PSA 8 −$15. Caption: "Know before you pay the grading fee." |
| Collection | Voice-style typing: "move my Umbreons to Grading pile". Confirm, done, the collection updates. Caption: "Your binder, by chat." |
| Vendor tag | Vendor POV: Multi-Scan a binder page, "OFFER $412 of $588", tap Send to seller, the seller's phone scans the QR and sees every card's price. Caption: "Show them the math. Close the deal." (fits the Vendor POV YouTube format from the September research) |

**Suggested prompt chips.** The empty-state chips are currently owner-picked: exactly 3 market prompts (`assistant-prompts.ts:3-9`, decision 2026-11-20). These are proposals only.
- Home (no cards): "Check a trade" · "Is anything I own worth grading?" · "What's my collection worth?"
- One card attached: "Is $__ a good price for this?" · "Should I grade this?" · "What's it worth vs what I paid?"
- Several cards attached: "Is $__ fair for these?" · "Trade check these" · "Which of these should I grade?"
- Scanner (vendor profile set): "What's my offer on these?"

---

## 5. Decisions (resolved 2026-11-21)

Researched online on 2026-11-21. Items marked **(default; owner can change)** are product defaults, not researched facts. Hobby percentages come from guides and forum posts, not surveys, so treat them as rough norms. Several grader pages block automated reads (HTTP 403); where that happened, the grader's own page was read through a Wayback Machine snapshot, or a secondary source was used and marked as such.

| # | Decision | Answer | Reason | Source |
|---|---|---|---|---|
| 1 | Grading fee table | A hand-maintained JSON in backend data: `backend/data/grading_fees.json` (as-of date, per-grader `source_url` and `retrieved_at`, editable without an OTA). It covers PSA, BGS, CGC, SGC and TAG with every tier, the value cap and turnaround. Tier rule: the cheapest *available* tier whose cap ≥ the card's value and whose minimum card count is met. Defaults for one card: PSA Standard **$59.99** (≤$1,000; Value tiers paused), CGC Economy **$20** (≤$1,000; Bulk $17 needs 25 cards), BGS Express **$79.95** (Base/Standard/Priority sold out), SGC **$50** (≤$1,500), TAG Standard **$59.95** (≤$1,000). Shipping: PSA's published return fee **$19.99** (1–4 cards, ≤$2,000 insured, insurance included); for graders with no published return fee, a **$20** default **(default; owner can change)**. Inbound shipping is not included. | Fees change several times a year, so they belong in backend data with dates, not in a client constant. Note: the PSA example in 2.3 ("~$45 fee") is out of date; PSA's cheapest open tier is $59.99. | PSA [pricing](https://www.psacard.com/pricing) (official, Wayback snapshot 2026-09-15) and [postage](https://www.psacard.com/info/postage) (official, Wayback snapshot 2026-11-10); [CGC fees](https://www.cgccards.com/submit/services-fees/cgc-grading/) (official, live); [Beckett grading](https://www.beckett.com/grading) (official, Wayback snapshot 2026-10-29); [TAG services](https://help.taggrading.com/en/articles/10692075-what-are-tag-s-available-grading-services) (official, 2026-10-21; Value and Base prices are secondary, from [pregradecards](https://pregradecards.com/blog/tag-grading-new-tiers-2026)); SGC: secondary only, [cardgrade.io](https://cardgrade.io/blog/sgc-standard-price-increase-50-september-2026) (gosgc.com blocks reads) |
| 2 | Deal verdict bands | **Buying:** ≤90% of market = good buy; 90–105% = fair; over 105% = over market (the `walk_away` verdict, worded neutrally as "above market"). **Selling to a vendor:** ≥80% = strong offer; 65–80% = typical; under 65% = low. Basis: **TCGplayer market** (the main USD price lane). Do not use "lower of market and recent solds": raw solds are not in the assistant's data. Slabs use the cached graded comp. **(default; owner can change)** | Show vendors usually price singles at or 5–10% under TCGplayer market, and buyers typically open at 80–90%. Paying above ~105% is paying more than the usual show sticker. Vendor cash buys mostly fall between 50% and 70%, so 80% or more is a strong sell. | [tistaminis vendor guide](https://tistaminis.com/blogs/blog/vending-at-pokemon-shows-a-beginner-s-guide) (secondary); [Card Codex negotiation guide](https://cardcodex.com/blog/how-to-negotiate-good-deals-at-card-shows/) (secondary); [pokemonpricing.com dealer %](https://pokemonpricing.com/what-percentage-of-a-cards-value-do-dealers-pay/) (secondary, 2026-04-06) |
| 3 | Trade bands and the fix | **Fair:** gap within 5% of the larger side. **Slightly uneven:** 5–15%. **Uneven:** over 15% (the July spec's neutral tone). **Fix:** the cash amount first, plus up to 2 near-value cards from the user's own collection, only when the user's side is short. | Trade calculators treat under 5% as fair and 5–10% as often acceptable, so 15% is a sensible outer edge for "slightly". Suggesting the user's own cards reuses `get_my_collection` and gives a concrete counter-offer. | [CardTrack trade calculator](https://cardtrack.com/pokemon/trade) (secondary, <5% = fair); [CardValueScanner trade calculator](https://cardvaluescanner.io/pokemon-card-trade-calculator) (secondary, 5–10% reasonable) |
| 4 | Vendor buy % and sell markup | Tiers are **on by default** and editable by the vendor. Raw singles: **bulk (<$5) 40%**, **$5–$50 60%**, **$50+ 70%**. **Slabs 70%**. Optional trade-credit bump: +10 points. **Sell markup default: 100% of market** (no markup), adjustable from 85% to 120%. **(default; owner can change)** | Dealers pay 50–70% at shows (about 68% for liquid cards, 60–65% for mid-tier, 30–55% for bulk, about 65% for graded). Forum vendors report "70% cash / 80% trade". A shop reselling on TCGplayer pays about 10.75% commission + 2.5% + $0.30, so roughly 13% in fees, which is why buy % sits below about 85%. Show sticker prices sit around market (5–10% under to slightly over). | [pokemonpricing.com](https://pokemonpricing.com/what-percentage-of-a-cards-value-do-dealers-pay/) (secondary); [Elite Fourum vendor thread](https://www.elitefourum.com/t/any-card-show-vendors-here-would-love-to-pick-your-brain/54638) (secondary, anecdotal); [TCGplayer fees](https://help.tcgplayer.com/hc/en-us/articles/201357836-Fees) (official); [tistaminis](https://tistaminis.com/blogs/blog/vending-at-pokemon-shows-a-beginner-s-guide) (secondary) |
| 5 | QR page | **DROPPED (owner, 2026-11-21: "no need for qr offer page").** No Send-to-seller sheet, no public `/o/<token>` page. The vendor shows the OFFER total on their own screen; Bought log kept. | Owner decision. | — |
| 6 | Vendor tag scope | Build it as a **non-AI scanner feature**, eligible for prod through the normal prod gate. The `compute_offer` chat tool stays with the AI features (staging-only). **(default; owner can change)** | Nothing in the tag needs an LLM, and tying it to the AI gate would keep it off prod for no reason. | Plan 2.5 |
| 7 | Remove by chat | **Allow it in-app** through `propose_remove_holding`, with a **red Confirm card** (exact printing, condition or grade, collection, "Remove 1 of 2") and a short Undo. **Never over external MCP**: no delete tool there. Update the "can't delete" rule at `engine.py:69` accordingly. **(default; owner can change)** | Confirm taps make chat removes as safe as the in-app button. External MCP clients have no Confirm step, so removes stay out of them. | Plan 2.4; `write_tools.py` (no delete by design) |
| 8 | Centering v2 | **Defer.** Ship grading v1 without centering. Revisit only if usage of "should I grade this?" justifies 3–4 days, and then only as a "rough", bordered-card-only cap. **(default; owner can change)** | Phone perspective, sleeves and full-art or borderless cards make the measurement rough. Without gem-rate data it would only be a cap, not an EV. A PSA 10 allows about 55/45 front centering, so small measurement errors would flip the cap. | [PSA grading standards](https://www.psacard.com/gradingstandards) (official, centering tolerances) |
| 9 | Composer attach | **Owner decided:** a **"+"** button offering **Take photo** (opens the scanner in return-to-chat mode, reticle capture) and **Upload photo** (photo library). Both are identified by the scanner's existing matcher. For uploads, add a crop or align-to-card-frame step on device rather than server-side detection, because YOLO crops regressed on real captures. | Owner's call. The crop step keeps the "reticle encodes intent" lesson. | Owner, 2026-11-21; memory: card-detector experiment ruled out |
| 10 | Starter chips | **Extend, don't replace.** With no cards attached, keep the owner's 3 market prompts unchanged. With cards attached, show the card-specific chips from section 4 ("Is $__ a good price for this?", "Should I grade this?", "Trade check these"). This builds on the existing tray-count starter prompts. **(default; owner can change)** | Respects the 2026-11-20 owner pick, and gives the new features a visible entry point exactly when they apply. | `assistant-prompts.ts:3-9, 16-44` |
| 11 | Comp freshness | **Never warm Scrydex listings from chat.** Use only what card-page views have cached (24h), and say "no recent sale" per grade when nothing is cached. **(default; owner can change)** | Warming would cost up to 9 credits per cold card per chat, against the Scrydex credit discipline. The assistant runs read-only with 0 credits per chat by design. | `readonly_service.py:17-39`; memory: Scrydex credit and caching discipline |

---

## 6. Appendix: file:line references

**Assistant backend**
- `backend/mcp_server/assistant/engine.py:41` system prompt; `:45` USD only, never yen; `:61-62` "worth grading" and tray PSA 10 rules; `:69` "can't delete, sell, list or buy"; `:71` scan-tray wording rule; `:72` "good buy" goes to market trends (needs a deal-check carve-out); `:412` `question_target_usd` ($ parser, watch wording only); `:737, :855` round-limit handling.
- `backend/mcp_server/assistant/config.py:57` `max_tool_rounds = 4`; default model Haiku 5.5; spend cap $5/day.
- `backend/mcp_server/assistant/service.py:31-34` `MAX_CONTEXT_CARDS = 20`, sources home/scanner; `:120-147` context parsing (card_ids, game, direct_add capability); `:224-231` tray context injected.
- `backend/mcp_server/assistant/tools.py:170-531` `TOOL_DEFINITIONS` (14 reads + 4 writes + `show_cards`); `:366-378` `grading_upside` schema (card_ids only, max 3); `:393-475` propose/add-now tools; `:1508-1530` dispatcher; `:1533-1596` read path; `:2057-2074` `scanner_context`.
- `backend/mcp_server/assistant/flags.py:41` currency-leak flag.
- `backend/mcp_server/readonly_service.py:17-39` assistant service has live pricing and Scrydex refresh OFF (0 credits per chat).

**Shared tools (`backend/mcp_server/tools.py`)**
- `:101-107` grading description; `:223-251` `usd_price` (None for non-USD) and price source label (tcgplayer lane).
- `:1091-1130` holding summary: cost basis, `gain_usd`, `gain_basis` (`cost_basis` | `since_added`); `:1161` `get_my_collection`.
- `:1620` `find_price_lows`; `:1866` `find_top_graded` (`price_verified` at :1994); `:2006-2075` `grading_upside`; `:2093-2136` `_graded_comp` (cached eBay sold, else Scrydex graded market); `:2403` `find_movers`; `:2588` `get_price_history`.

**External MCP write tools**
- `backend/mcp_server/write_tools.py:1-11` toggle doc; `:37-39` "Turn on 'Let AI assistants edit my collection'"; `:171-226` add (takes collection_id); `:228-284` update (no remove); `:286-310` watch; `:331-343` gate check; `:379-460` registration. `backend/mcp_server/policy.py:41` `WRITE_TOOLS`. `backend/user_ai_settings.py:34` `allow_mcp_edits`.

**Backend services**
- `backend/server.py:597` `RECENT_SALES_FRESHNESS_HOURS = 24`; `:1060-1070` binder page prepare (per-owner pocket store); `:10588-10700` `record_buy`; `:10980` `delete_deck_entry`; `:18992` `card_recent_sales` (game-aware, skips games without listings); `:23508` `create_collection`; `:23560` `update_collection` (rename/hide only); `:27058` `_write_html`; `:28692` card price-trends route; `:30007` `/api/v1/buys`; `:30371-30582` deck-entry routes (no move).
- `backend/recent_sales.py:238-262` sold-comp USD reconciliation (eBay > FX > Scrydex).
- `backend/catalog_tools.py:2122-2218, 2414` per-game `has_graded_pricing`.

**RN app**
- `apps/spotlight-rn/src/features/assistant/assistant-prompts.ts:3-9` owner-picked chips; `:16-44` starter prompts by tray count.
- `.../assistant/use-assistant-chat.ts:71-74, 140-142` context sent on the first question only.
- `.../assistant/components/assistant-composer.tsx:26-34` composer props (text only, no attach).
- `.../assistant/assistant-action-runner.ts:227-233` handled action types (add, update, watch).
- `.../assistant/assistant-route.ts:6-28` `assistantHref` (max 20 card ids).
- `.../scanner/screens/scanner-screen.tsx:4373-4382` Ask Ekalight from the tray; `:1264-1300` deal "% OF MARKET" state and presets; `:4098-4105` discounted total; `:5126-5140` total pill.
- `.../scanner/components/custom-discount-sheet.tsx:6-27` custom % of market.
- `.../scanner/scanner-normalized-target.ts:184-186` binder layouts (3x3 only).
- `.../events/booth-service.ts:94` `claimBooth`, `:150` booth stats.
- `.../cards/components/card-detail-hero.tsx:37` pinch-zoom (the only "centering" reference in the app).

**Eval harness**
- `backend/assistant_eval/cases.yaml:1-50` format notes and defaults (banned yen, provider names, tables); `:625-667` `worth_grading` (fixtures + rubric math); `:872-905` scanner tray cases.
- `backend/assistant_eval/grading.py:45` `PLANNED_TOOLS`; `:49-91` `EXPECT_KEYS`; `:93` matcher ops.
- `backend/assistant_eval/cases.py:24-29` case and turn keys; `:225` planned tools allowed.
- `backend/tools/assistant_eval.py` runner; `docs/ai-chat-eval-2026-11-19.md:40-67` how to run.

**Docs and memory**
- `docs/grading-advisor-and-trade-analyzer-spec-2026-07-16.md` (both specced, not built; neutral trade tone; ~$25 fee constant).
- `docs/problem-discovery-research-2026-09-24.md:19-22` stack → offer, QR receipt, bought log, tiered buy %.
- `docs/marketplace-business-plan-2026-07-07.txt:306-308` vendor offers on scanned cards (Phase 2).
- `docs/booth-posts-vendor-spec-2026-10-29.md:19` "No QR signs".
- `docs/listing-feed-concept-2026-08-28.md:194-195` shop buylists give scan-to-offer its density (not scheduled).
- Memory: PokemonPriceTracker fully removed 2026-10-14 (graded comps Scrydex-only, no gem rate); currency reconciliation (eBay Browse precedence); vendor-first reframe superseded 11/16 (mostly attendees); prod release branch (AI not in prod); Scrydex credit discipline; never show yen; scanner do-nots; card-detector experiment ruled out.
