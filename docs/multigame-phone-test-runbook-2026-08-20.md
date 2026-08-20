# Multi-game phone test runbook — 2026-08-20

Everything below runs from the **worktree** (`/Users/stephenchan/Code/spotlight-onepiece`),
never the main tree. Hard rule for this branch still applies: **no deploys, no
OTA, no EAS** — this is local-only until it merges.

## What you are testing

Five games in one app: Pokémon (untouched), plus **One Piece, Lorcana,
Riftbound, Gundam** — search, collect, PDP, and a scanner lane for each. The
decision on record (2026-08-20): every game with an index gets a lane, including
the two with no real-photo validation yet.

## 0. One-time: get the right binary on the phone

The installed TestFlight build shares the `spotlight://` scheme, so **scanning
the Expo QR will open the WRONG app** (the store build, silently pointed at the
wrong backend). You need a dev-client build of THIS worktree on the phone:

```bash
cd /Users/stephenchan/Code/spotlight-onepiece/apps/spotlight-rn
npx expo run:ios --device        # plug the phone in, pick it from the list
```

If Metro or a backend from another session is already up, ports will collide —
check first: `lsof -tiTCP:8081 -sTCP:LISTEN` and `lsof -tiTCP:8788 -sTCP:LISTEN`
(kill whatever's stale).

## 1. Start backend + Metro

```bash
cd /Users/stephenchan/Code/spotlight-onepiece
bash tools/start_multigame_phone_dev.sh --dev-client
```

That script serves the **merged 5-game catalog**
(`backend/data/spotlight_multigame_test.sqlite`), wires the Pokémon index from
the main tree plus the four per-game indexes, forces the SigLIP2 encoder, binds
`0.0.0.0:8788` so the phone can reach it, and hands off to the normal
phone-dev script for LAN-IP/Expo wiring. VPN or multi-interface Mac:
`SPOTLIGHT_PHONE_IP=192.168.x.x bash tools/start_multigame_phone_dev.sh --dev-client`.

It **refuses to start** if something already listens on 8788 — that's on
purpose (you'd silently test the wrong catalog). Backend-only variant:
`bash tools/start_multigame_test_backend.sh`.

## 2. The checklist

Fastest "am I on the right bundle" check: the scanner's **"Scanning for"**
sheet lists One Piece / Lorcana / Riftbound / Gundam as lanes, and shows
*Magic: The Gathering / Sports / Yu-Gi-Oh* as Coming soon.

1. **Lanes**: switch to each of the four new lanes; each scans without the
   "isn't available yet" banner. Pokémon EN and JP lanes still work.
2. **Scan accuracy expectations** (so you know what "working" looks like):
   - **One Piece EN**: the validated lane — 88.6% top-1 on real photos. Scan
     anything; alt-art/manga Secret Rares are the known hard class.
   - **One Piece JP**: allowed but degraded — ~43% top-1, ~86% top-10 (the
     index is EN reference art; Scrydex has no JP catalog for any new game —
     measured 2026-08-20, see the spike doc). Expect the right card to often
     sit in the candidate tray rather than at the top.
   - **Lorcana / Riftbound / Gundam**: plumbing-verified, never validated on
     real photos. This test IS the validation — note what you see.
3. **Search follows the lane**: "luffy" finds cards in the One Piece lane,
   nothing in the Pokémon lane.
4. **The graded contrast**: a One Piece PDP shows raw pricing, NO PSA/BGS/CGC
   lanes, no empty population block. A **Lorcana** PDP shows graded lanes
   across 8 graders **and the sold-comps drawer** (newly enabled — the client
   capability flag now matches the backend's measured probe).
5. **Set browse is scoped**: ~53 One Piece sets, not 449 Pokémon ones.
6. **The id collision**: One Piece `EB01-001` (Kouzuki Oden) and Gundam
   `EB01-001` (Gundam Astray Red Frame Custom) both exist and open the right
   PDP.
7. **Marketplace links**: One Piece TCGplayer link opens the right product;
   eBay link searches the game's keyword, not "pokemon".
8. **Pokémon untouched**: graded lanes, population, marketplace links, search —
   exactly as production.
9. **Mixed collection**: add a card from each game; the collection renders all
   five, and the game filter chip row appears once the collection spans games.

## Known-good baseline (verified 2026-08-20 before handoff)

Backend boots against the merged DB; per-game search/expansions/PDP respond
game-scoped with namespaced ids; scan round-trips work per lane with no
cross-game leakage; backend gate + full RN suite + tsc green. If something on
the phone contradicts this, suspect the phone/Metro wiring first (wrong binary,
stale bundle, LAN IP), then the backend log in the script's terminal.

## Out of scope / expected gaps

- No graded pricing or pop reports for One Piece / Riftbound / Gundam — data
  doesn't exist on Scrydex (email drafted in the spike doc, unsent).
- No JP lane for any new game — no JP catalog on Scrydex (same email).
- Prices are the Aug-13/14 sync snapshot; live refresh policy for non-Pokémon
  games is deliberately undecided.
