# Scanner V1 Known Limitations

Date: 2026-04-03

These are the current known limitations for Spotlight scanner v1.

## Scope Limits

- Pokémon only
- one card per photo
- English-first
- raw cards and PSA slabs only
- no binder-page or multi-card-photo support
- no BGS / CGC grade-aware pricing

## Pricing Limits

- raw and PSA refresh now prefer `Scrydex`
- imported Pokémon TCG snapshot pricing is still retained as the current fallback cache
- exact live market truth is not guaranteed on every scan
- slab pricing can still fall back to `Raw proxy` when true slab comps or graded provider values are unavailable

## Resolver Limits

- raw-card quality is strongest on upright single-card photos with visible bottom metadata
- top loaders, glare, rotation, and older cards still produce more review states than modern clean raws
- some Japanese scans may identify weakly or remain unsupported unless explicitly imported/tested

## Catalog Freshness Limits

- automated catalog sync/state now exists, but it still depends on the configured local manifest and Pokémon TCG API availability
- live catalog miss recovery currently focuses on structured raw misses with set/number hints
- PSA slab misses do not yet use the same live catalog miss-import path

## External Dependency Limits

- live Scrydex validation still depends on real credentials
- slab-source sync adapters exist for PSA APR/eBay/Goldin/Heritage/Fanatics, but full production live-auth coverage across all sources is still incomplete

