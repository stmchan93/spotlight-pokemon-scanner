# Pricing Provider Abstraction Spec

Date: 2026-04-04

This doc defines the next pricing architecture change for scanner v1.

## Goal

Support multiple pricing providers side by side without blending their numbers together.

Immediate product requirement:

- make `PriceCharting` the default active provider for testing now
- keep `Scrydex` code in the repo and available
- preserve current local fallback paths
- later allow the app to show:
  - `PriceCharting price`
  - `Scrydex price`
  - local fallback/slab-comp price

This is **not** a price-merging project.

## Core Rule

Do not normalize provider prices into one combined market number.

Instead:

- each provider returns its own normalized payload shape
- the app/backend can choose one provider as the active default
- the app can later show multiple provider values side by side

What gets normalized:

- field names
- timestamps
- currency code
- raw vs PSA grade shape

What does **not** get normalized:

- the actual price values from different providers into one blended number

## Active Default For The Next Step

For immediate testing:

- `Raw default provider = PriceCharting`
- `PSA default provider = PriceCharting`

Fallback order:

- raw:
  - `pricecharting`
  - `scrydex`
  - imported snapshot
- psa:
  - `pricecharting`
  - `scrydex`
  - local slab-comp model
  - raw proxy

The active default should be configurable and not hardcoded forever.

## Architecture

### Provider Contract

Create a shared provider interface for:

- raw refresh
- PSA refresh
- credential readiness
- provider metadata

Each provider should return:

- provider id
- provider label
- pricing mode
- price fields
- source URL
- timestamps
- slab/grade metadata when relevant

### Provider Registry

Add a registry that:

- knows which providers are available
- knows provider priority order
- tries providers in order for refresh
- records which provider actually won
- exposes readiness/status to ops endpoints

### Persistence Rule

Keep persisting provider-specific values as provider-specific snapshots.

For the current app flow:

- the backend can still return one active/default price in the existing top-level pricing field
- but it should also preserve the winning provider identity cleanly

Future extension:

- store multiple provider snapshots for the same card so the UI can show them side by side in details

## UI Rule

Short term:

- tray row shows the active/default provider result only
- active/default provider should be `PriceCharting` for now

Later:

- details view can show:
  - PriceCharting
  - Scrydex
  - local slab-comp estimate

Again:

- no averaging
- no blending
- no hidden mixing

## Non-Goals

- no multi-provider averaging
- no “best market value” synthesis
- no change to scanner resolver logic in this step
- no removal of Scrydex

## Acceptance Criteria

The abstraction step is done when:

- backend refresh code no longer depends directly on one provider
- PriceCharting can be used as the default active provider
- Scrydex still works through the same shared layer
- app labels show the winning provider correctly
- provider order can be changed through config
- tests cover provider fallback order and provider-specific outputs
