# Type-scale migration (Figma library styles → design-system tokens)

Started 2026-10-18. Source of truth: Figma file `XRUD89H31ESUrvf9fGMtjW` (Spotlight App). The
designer replaced ad-hoc text with 11 named library text styles; every screen's text should map to
one of them. Code consumes `textStyles`/`typography.<role>` from `packages/design-system/src/tokens.ts`
(42 roles today), so the migration is a token re-cut plus a per-screen role audit — not a rewrite.

## Canonical scale (Plus Jakarta Sans, line height AUTO, letter-spacing 0)

| Figma style | Weight / size | Notes |
|---|---|---|
| Display | Bold 29 | |
| Title-large | Bold 23 | |
| Title-medium | SemiBold 19 | |
| Title-small | SemiBold 17 | |
| Body-large | Regular 16 | sign-in only so far |
| Body | Regular **14** | older frames (PDP, Wishlist, Sign-in, Insights) still show the stale 15 |
| Body-medium | Medium **14** | older frames show the stale 15 |
| Label | Medium 14 | |
| Caption | Regular 13 | |
| Caption-medium | Medium 13 | |
| Overline | Regular 12 | Sign-in frames still carry an old "Overline" Medium 11 |

`Body/Regular 17` (SF-style, lh 22) appears on the Post-flow keyboard frames only — iOS system text, not ours.

**Drift to raise with the designer:** same library key, different metrics per page → pages need
"update from library". Code follows the newest frames (Home/Profile, Events).

## Line-height policy (decision)

Figma says AUTO (≈1.26× for Plus Jakarta). RN/Android needs an explicit box: use **round(size × 1.3)**
for all roles (Body 14 → 18, Label 14 → 18, Title-small 17 → 22, Display 29 → 38). Keep the
existing Android line-box comment on `display`.

## Display weight (decision)

The old ExtraBold "display" family with negative tracking is retired: Figma's Display/Title-large are
Bold with 0 tracking. `fontFamilies.display` stays loaded until the last `feed*` consumer is moved,
then the ExtraBold file is dropped from `useFonts`.

## Phases

1. **Inventory** (read-only, 4 agents by area) → `mapping-<area>.md`: per screen, the roles used,
   the Figma style each element should carry, hardcoded `fontFamily`/`fontSize` sites.
2. **Token re-cut** (one change): add the 11 Figma-named roles to `tokens.ts`; alias every legacy
   role to its Figma style; list retirements.
3. **Flip + contact sheet**: typecheck, jest, screenshot every dev route before/after.
4. **Per-screen sync** (agents, disjoint files): fix call sites, hardcoded fonts, overflow.
5. **Audit agent**: every Figma screen frame vs the simulator, typography only; report misses.

## Files

- `figma-text-styles.json` — the 11 styles.
- `figma-screen-inventory.md` — every product frame in the file with the styles it uses.
- `code-text-roles.json`, `code-role-usage.txt` — current tokens and how often each role is used.
- `mapping-*.md` — phase-1 output per area.
