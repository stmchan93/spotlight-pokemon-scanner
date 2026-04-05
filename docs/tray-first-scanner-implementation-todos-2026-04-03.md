# Tray-First Scanner Implementation Todos

Date: 2026-04-03

Purpose: track the active implementation work for the video-style live scan tray and the next scanner-quality improvements.

## Core UX

- [x] Replace the old detail-page-first scanner loop with a persistent scanner surface.
- [x] Insert a pending row immediately when a scan starts.
- [x] Resolve the pending row in place instead of pushing a new full-screen result screen.
- [x] Keep one running total visible in the tray header.
- [x] Keep inline row expansion for `low / market / mid / high`.
- [x] Keep manual correction in a sheet instead of leaving the scanner.

## Latency

- [x] Use candidate pricing from the match response immediately.
- [x] Remove eager detail fetches from the hot path.
- [x] Defer pricing refresh until scanning pauses.
- [x] Keep refresh row-scoped instead of blocking the entire scanner.

## Resolver / Scan Quality

- [x] Promote `bottom strip -> direct lookup` as the default Pokemon path.
- [x] Add resolver-mode hints to the scan contract.
- [x] Add resolver router behavior for `raw_card`, `psa_slab`, and `unknown_fallback`.
- [x] Add PSA label-first matching behavior.
- [ ] Add on-demand catalog hydration for older cards outside the initial imported slice.
- [x] Improve low-confidence behavior for fake/custom/unknown cards so they do not silently match the wrong card.

## Coverage / Catalog

- [x] Expand imported catalog coverage for the older cards represented in the latest photo batch.
- [ ] Keep pricing aligned to the normalized Pokémon TCG API provider payloads.
- [ ] Make the imported backend the main manual test path for supported real cards.

## QA / Testing

- [x] Keep backend unit tests green.
- [x] Add tray-logic command-line tests.
- [x] Add resolver-router backend tests.
- [ ] Add local regression assets for any new on-disk real-world photos.
- [x] Run both sample and imported regression suites after backend changes.

## Docs

- [x] Update the resolver-router spec with the implemented router behavior.
- [x] Update the master status doc with the tray-first scanner behavior and test commands.
- [x] Record blockers for the chat-only image attachments that are not available as local files yet.
