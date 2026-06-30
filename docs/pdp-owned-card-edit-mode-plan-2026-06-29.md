# Owned-card PDP edit mode (Cost Basis + SAVE/CANCEL) — plan, 2026-06-29

## In plain English

Today, the product detail page (PDP) is always in **"Add" mode**: it shows the card, a few chips (Language / Variant / Grader), and an **ADD ITEM** button. Condition, Quantity, and the grade picker live inside a pop-up sheet, and there's no way to record what you *paid* for a card.

The new Figma (node `1874-21729`) turns the PDP into an **edit screen for cards you already own**: all the options sit inline on the page (Language, Variant, Grader, Condition, Quantity, and a new **Cost Basis** field), with **SAVE / CANCEL** at the bottom and trash/share at the top. SAVE writes your changes back to that owned line; the portfolio and Insights then recalc.

**Have vs. need (corrected 2026-06-29 after reading the backend):**
- **Have:** the inline chips (Language/Variant/Grader), the grade/condition picker (`GradeConditionSheet`), a quantity stepper (in the Add sheet), the trash/share header, a `costBasisPerUnit` field on inventory entries — **and a complete set of granular backend update endpoints that already persist edits to an owned line:** `POST /api/v1/deck/entries/{cost-basis, condition, quantity, purchase-price, listing}`. The cost-basis edit (`update_deck_entry_cost_basis`) is owner-scoped, writes `cost_basis_cents` + total, and is covered by passing tests. **So SAVE is fully supported by the backend today** — my first audit missed these because it only looked at `replacePortfolioEntry`.
- **Need:** (1) thin **API-client methods** for the field-update endpoints that aren't wired yet (only `/quantity` is exposed client-side; `/cost-basis` and `/condition` are not); (2) the inline **edit-mode UI** on the PDP (move Condition/Quantity inline, add the Cost Basis input, add a SAVE/CANCEL action bar + edit state); (3) seeding those fields from the owned entry.

Net effect: this is **smaller than first thought** — no backend work is required. The remaining phases are an API-client shim and the RN UI, both safe and revertible.

## Already shipped (2026-06-29, the cosmetic part)
- Removed the `#` before the collector number on Collection tiles.
- Selected filter chips now render **black** (gray900) instead of a purple border.
- Tightened PDP section spacing (32 → 24).
- Trash + share already sit in the PDP header for owned cards.

## The design (Figma 1874-21729)
Owned-card PDP, top→bottom: header (back · title · **trash** · **share**) → hero → identity (name / `193/162` / set, no `#`) → **inline options**: Language, Variant, Grader, Condition (dropdown), Quantity (stepper), **Cost Basis** → Population → Price Trend → Product Details → **SAVE (accent) / CANCEL (outline)** action bar. Cost Basis shows either an editable input (`$0.00 (or value if traded or gifted)`) or, once set, the stored value with a gain chip and `Updated <date>`.

---

## Phased plan

### Phase 1 — Backend ✅ ALREADY DONE (verified 2026-06-29)
No work required. The backend already exposes owner-scoped, tested field-update endpoints:
- `POST /api/v1/deck/entries/cost-basis` → `Service.update_deck_entry_cost_basis` (`server.py:12534`, route `:15909`): accepts `deckEntryID` + `costBasisPerUnit` (dollars) or `costBasisPerUnitCents`; null clears; writes `cost_basis_cents` + `cost_basis_total` + currency. Tests: `tests/test_collections_redesign.py::test_update_deck_entry_cost_basis_writes_cents_and_total` and `_supports_clear` (both pass).
- Sibling endpoints for the other inline fields: `/condition`, `/quantity`, `/purchase-price`, `/listing` (`server.py:15769–15929`).
- **Decision still to confirm with design:** cost basis is stored **per-unit** (total = per-unit × qty). The endpoint takes per-unit, so the UI input should too.

### Phase 2 — API client (thin shim) ✅ DONE (2026-06-29)
- Added `updateDeckEntryCostBasis({ deckEntryID, costBasisPerUnit })` → `POST /api/v1/deck/entries/cost-basis`, with `UpdateDeckEntryCostBasis{Request,Response}Payload` types (`types.ts`), the interface decl + HTTP impl + mock impl (`repository.ts`), and the delegating fake (`__tests__/test-utils.tsx`). Mirrors the `/quantity` method. Typechecks (api-client + mobile) and tests pass.
- **Still open for Phase 3:** a `/condition` update method if the inline Condition control should persist immediately on change (vs. only on SAVE). Decide alongside the UI.

### Phase 3 — RN: owned-card inline edit mode on the PDP ✅ DONE (2026-06-29)
- New presentational component `OwnedEntryEditFields` (`components/owned-entry-edit-fields.tsx`): inline Condition/Grade dropdown + Quantity stepper + Cost Basis `TextField` with a gain chip (market − cost basis) and optional "Updated" line.
- `card-detail-screen.tsx`: edit mode is on whenever `selectedEntry != null`. Variant/Grader/Grade/Condition reuse the already-seeded page configurator state; added `editQuantity` + `editCostBasisText` (seeded once per entry id) and a page-hosted `GradeConditionSheet`.
- **SAVE** (`handleSaveEdit`): `replacePortfolioEntry({ slabContext, variantName, condition, quantity, unitPrice: costBasis ?? 0, … })` → then `updateDeckEntryCostBasis({ deckEntryID: <replace response id>, costBasisPerUnit })` (authoritative cents; handles the new row id on identity change) → `refreshData()` + `onBack()`. **CANCEL** = `onBack()`. Trash stays in the header.
- Action bar is conditional: owned → SAVE/CANCEL; non-owned → ADD ITEM/SHARE (unchanged). Note this **replaces** the old "owned cards stay in ADD ITEM" behavior; 3 tests updated + a SAVE-persistence test added (card-detail suite: 32 pass; full suite green).

### Phase 4 — Spacing pass + verify ✅ DONE
- The inline fields use the design's option spacing (16px between groups, 10px title→control); PDP section gap already tightened to 24. Typecheck + lint + full test suite (696 pass) green.

---

## Verification
- `pnpm --filter @spotlight/mobile-app typecheck` + lint clean; design-system `tsc` clean.
- Backend: new replace-with-cost-basis test passes; owner-scoping holds.
- Manual: open an owned card → change condition/quantity/cost basis → **SAVE** → values persist, Collection + portfolio/Insights reflect the new cost basis; **CANCEL** discards; trash still deletes. Repeat for a graded (slab) entry. Confirm a non-owned card (from search) still shows Add mode.

## Open questions
- **Cost basis = per-unit or total?** (plan assumes per-unit). 
- **Grader change on an owned card:** does SAVE allow switching raw↔graded, or is grader fixed once owned? (affects whether replace must rebuild slab context).
- **Cost Basis gain chip:** is the `↑$100.16` gain vs. current market computed client-side from market price − cost basis? Confirm the comparison basis.

## Appendix — key files / anchors
- PDP: `apps/spotlight-rn/src/features/cards/screens/card-detail-screen.tsx` — header (~1024), action bar (~1167), inline `CardConfigurator` (~1090), `selectedEntry` (~308), seed effects (~374), `displayNumber` (~60).
- Add sheet (quantity stepper, grade trigger): `apps/spotlight-rn/src/features/cards/components/add-to-collection-sheet.tsx`.
- Grade/condition picker: `apps/spotlight-rn/src/features/cards/components/grade-condition-sheet.tsx`.
- Chips: `apps/spotlight-rn/src/features/cards/components/card-configurator.tsx` (`OptionChip`, already gray900-selected).
- Update payload/method: `packages/api-client/src/spotlight/types.ts` (`PortfolioEntryReplaceRequestPayload`, ~879; `InventoryEntryCreateRequestPayload.costBasisPerUnit`, ~865) and `repository.ts` (`replacePortfolioEntry`, ~155).
- Backend create path that already writes `cost_basis_cents` (mirror for replace): `backend/server.py` (create-entry handler) + the replace handler.
- Entry cost-basis fields: `types.ts` `InventoryCardEntry.costBasisPerUnit` / `costBasisTotal` (~282).
