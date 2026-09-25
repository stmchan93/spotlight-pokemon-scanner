# Scan tray: uncapped + virtualized — plan (2026-09-24)

Status: PLANNED, not started. Goal from the owner: the scan tray is a real
virtualized list and has no card cap; persisted rows keep ALL candidates.

## Have vs need

| | Today | Needed |
|---|---|---|
| List | `Reanimated.ScrollView`; custom windowing swaps off-screen rows for shells, but all N rows stay mounted | FlashList v2 (JS-only, New Arch — we're on RN 0.83.6 with `newArchEnabled`) |
| State | `recentCaptures` array in the 5,900-line `ScannerScreen`; ~30 `setRecentCaptures(c => c.map(...))` sites | `tray-store.ts` (useSyncExternalStore): `ids`, `byId`, per-row selectors; one row update re-renders one row |
| Storage | One AsyncStorage blob, 150-row cap, candidates trimmed to `PERSISTED_CANDIDATES_MAX = 10` | Owner-scoped folder: `scans/<ownerKey\|anon>/index.json` + `rows/<id>.json` (all candidates) + images |
| Cap | `maxStoredCaptures = 150`, `applyCapEviction` deletes the oldest | No eviction; soft warning ~500 rows; disk guard (warn + block new scans when low, never evict) |

## Phases (all JS-only → OTA; verify no new pods after adding FlashList)

0. **Guardrail:** CI fingerprint check that blocks an OTA whose bundle needs native code (runtimeVersion is a hand-set string per env in `app.config.js`).
1. **P0 — store extraction (3–5 days):** no visible change. Tests: store unit tests, "patch one row re-renders one row", incremental totals equal full recompute.
2. **P1 — FlashList v2 (1–1.5 wk), cap stays 150:** flat item list (`pageHeader` / `row` / `clearAll`), fixed sizes (row 102+24, header 40+24), `key = capture.id`. Keep the single-owner height animation + clipping container; list gets a fixed expanded height; pass the existing GestureDetector + Reanimated.ScrollView via `renderScrollComponent`. Recycling breaks Reanimated `entering/exiting/LinearTransition` → delete = row-owned slide/fade then store removal; insert = one-shot slide-in keyed on new id; siblings snap. Reset swipe state on id change. Fallback: LegendList with recycling off. NOT FlatList (mount/unmount churn = the old tray crash pattern).
3. **P2 — per-row storage + all candidates + migration (1 wk):** write only changed rows (temp file → move), index last; migrate old blob with today's owner check (adopt unstamped legacy), delete blob only after index is written; idempotent after a crash. Already-trimmed legacy rows stay trimmed (`totalCandidateCount` refetches).
4. **P3 — remove the cap (≈1 wk + soak):** drop `applyCapEviction`/`RECENT_CAPTURES_MAX`; load index + summaries at startup, full candidates on demand (LRU ~50); 200px row thumbnail; `onError` for missing images + idle orphan sweep instead of a startup existence scan; incremental price summary. Soak: 1000 scans on a low-end Android.
5. **P4 (optional, native build):** expo-sqlite; exclude scans from iCloud backup.

## Rules that constrain this
- Never drop `candidates[]` from persisted rows.
- Persisted account data is owner-scoped (sessionOwnerKey); owner mismatch wipes the other owner's folder.
- Scan artifacts are private (app sandbox only).
- Don't change normalized-target resolution/crop without a show-holdout accuracy check.

## Risks
Startup time / memory / OS kills on low-end Android; Clear All + Add All over 1000 rows (batch backend calls); price refresh for 1000 rows; iCloud backup size; disk (~300KB/image × 1000).
