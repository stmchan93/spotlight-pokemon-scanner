# Scanner V1 Release Notes

Date: 2026-04-03

## What’s In

- tray-first one-screen scanner flow
- raw card routing with bottom-strip-first lookup
- PSA slab routing with label-first lookup
- explicit review and unsupported states
- cached pricing in-row with source/freshness labels
- Scrydex refresh path for raw singles and PSA slabs
- slab price snapshot model with tiered fallback behavior
- catalog sync state/reporting and live structured miss recovery
- deterministic clean-pack and real-world regression runners

## What’s Still Limited

- exact live market truth is not guaranteed on every scan
- some slab prices can still fall back to raw proxy
- live external slab comp coverage is still incomplete
- multi-card photos and binder pages are out of scope for v1

