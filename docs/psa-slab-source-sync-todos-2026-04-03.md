# PSA Slab Source Sync Todos

Status: Active
Date: 2026-04-03

- [x] Choose the first real slab sales source.
- [x] Add a provider-agnostic sync module.
- [x] Implement the first source adapter: `psa_apr_html`.
- [x] Add manifest-driven sync commands.
- [x] Add scheduled watch-mode sync.
- [x] Reuse the shared slab-ingestion and recompute pipeline.
- [x] Add deterministic fixture-based tests for source parsing and import.
- [x] Add sample source manifest and update runbooks.

## Still Next

- [ ] Add authenticated live fetch validation against real PSA Auction Prices pages.
- [ ] Add additional source adapters after provider access is clarified.
- [ ] Add a server-exposed sync status endpoint if operational visibility is needed in-app.
- [ ] Add source-level cert/title normalization across multiple providers.
