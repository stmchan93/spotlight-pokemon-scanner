# AGENTS

Repo-specific workflow notes for future coding agents.

## Scope

- This repo's active product is a React Native app plus a Python backend for the Spotlight card scanner.
- `Spotlight/` is a legacy Swift/iOS implementation that is expected to be removed. Do not add new product work there unless the user explicitly asks for legacy Swift support.

## Read First

- Read this file first.
- Then read [docs/spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md) for current product/runtime state.
- Read [PLAN.md](/Users/stephenchan/Code/spotlight/PLAN.md) when milestone or rollout context matters.
- Read [docs/agent-context-index.md](/Users/stephenchan/Code/spotlight/docs/agent-context-index.md) to find the current source-of-truth spec for the subsystem you are changing.
- Then read the scoped `AGENTS.md` for the touched area:
  - backend work: [backend/AGENTS.md](/Users/stephenchan/Code/spotlight/backend/AGENTS.md)
  - React Native work: [apps/spotlight-rn/AGENTS.md](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/AGENTS.md)

## Repo-Wide Invariants

- Treat the backend as the runtime source of truth for card metadata, persisted pricing snapshots, scan logging, and training/export state.
- Treat scan artifacts as private. Do not make scan captures or normalized targets public.
- Keep scan identity states separate:
  - `predicted_card_id`
  - `selected_card_id`
  - `confirmed_card_id`
- `confirmed_card_id` is the trusted training/export label. Do not collapse it into prediction or review-only states.
- Raw identity/reference/pricing stays on the Scrydex-first lane.
- Slab identity/pricing stays on the Scrydex lane.
- Do not introduce PSA official API verification as a runtime dependency.
- Do not reintroduce deleted legacy raw runtime paths such as `RawCardScanner`.
- Do not reintroduce bundled runtime card catalogs, bundled identifier maps, or startup-seeded local JSON runtime sources of truth.
- Prefer stable policy in `AGENTS.md` and keep volatile rollout numbers, corpus counts, experiment metrics, and ops state in `docs/`.

## Repo Map

- React Native app: `apps/spotlight-rn/`
- Python backend: `backend/`
- Active docs/specs: `docs/`
- Tools and validation scripts: `tools/`
- QA fixtures and manifests: `qa/`
- Legacy Swift implementation: `Spotlight/`

## Routing

- If the task is backend-only, read [backend/AGENTS.md](/Users/stephenchan/Code/spotlight/backend/AGENTS.md) and stay within backend rules.
- If the task is RN-only, read [apps/spotlight-rn/AGENTS.md](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/AGENTS.md) and stay within RN rules.
- If the task crosses backend and RN, read both scoped files before editing.
- If a task depends on current rollout state, metrics, or migration phase, use [docs/agent-context-index.md](/Users/stephenchan/Code/spotlight/docs/agent-context-index.md) to jump to the right current spec instead of expanding this file.

## Source Of Truth Docs

- Master status: [docs/spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md)
- Agent doc index: [docs/agent-context-index.md](/Users/stephenchan/Code/spotlight/docs/agent-context-index.md)
- Raw visual migration: [docs/raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md)
- Raw visual model improvement: [docs/raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md)
- Raw set-badge/Scrydex-first migration: [docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md)
- OCR rewrite: [docs/ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md)
- Slab rebuild: [docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md)
- Labeling pipeline: [docs/scan-data-labeling-pipeline-spec-2026-04-23.md](/Users/stephenchan/Code/spotlight/docs/scan-data-labeling-pipeline-spec-2026-04-23.md)
- RN normalized target plan: [docs/react-native-scanner-normalized-target-mvp-plan-2026-04-28.md](/Users/stephenchan/Code/spotlight/docs/react-native-scanner-normalized-target-mvp-plan-2026-04-28.md)
- RN ML Kit slab plan: [docs/react-native-ml-kit-psa-slab-plan-2026-04-29.md](/Users/stephenchan/Code/spotlight/docs/react-native-ml-kit-psa-slab-plan-2026-04-29.md)

## Validation

- Run the relevant tests for the area you changed.
- Use the scoped `AGENTS.md` file for exact commands and validation expectations.
- Before any staging backend deploy or staging iOS build/release, route through the staging release gate instead of calling the raw deploy/EAS wrappers directly:
  - `pnpm release:gate:staging`
  - `pnpm release:gate:staging:build`
  - `pnpm release:gate:staging:release`
