# Agent Context Index

This index keeps volatile rollout state, migration phases, corpus notes, and implementation plans out of `AGENTS.md` while preserving a stable way for agents to find the current source of truth.

## Start Here

- Current product/runtime status: [spotlight-scanner-master-status-2026-04-03.md](/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md)
- Milestone context: [PLAN.md](/Users/stephenchan/Code/spotlight/PLAN.md)

## Raw Scanner And Visual Matching

- Active raw visual migration contract: [raw-visual-hybrid-migration-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-hybrid-migration-spec-2026-04-11.md)
- Next-step raw model improvement plan: [raw-visual-model-improvement-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-model-improvement-spec-2026-04-11.md)
- Raw set-badge and Scrydex-first migration: [raw-set-badge-scrydex-first-migration-spec-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/raw-set-badge-scrydex-first-migration-spec-2026-04-12.md)
- Earlier landed raw backend reset baseline: [raw-backend-reset-spec-2026-04-08.md](/Users/stephenchan/Code/spotlight/docs/raw-backend-reset-spec-2026-04-08.md)
- Local raw visual dataset workflow and corpus handling: [raw-visual-local-dataset-workflow-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/raw-visual-local-dataset-workflow-2026-04-12.md)

Use these docs for:

- current migration phase
- held-out metrics and experiment results
- active artifact aliases and model publication state
- dataset roots, batch intake, and corpus workflow details

## OCR Rewrite

- Active OCR rewrite contract: [ocr-architecture-rewrite-spec-2026-04-09.md](/Users/stephenchan/Code/spotlight/docs/ocr-architecture-rewrite-spec-2026-04-09.md)
- OCR simplification/performance follow-up: [ocr-simplification-performance-implementation-spec-2026-04-10.md](/Users/stephenchan/Code/spotlight/docs/ocr-simplification-performance-implementation-spec-2026-04-10.md)
- Raw OCR hardening notes: [raw-ocr-hardening-spec-2026-04-10.md](/Users/stephenchan/Code/spotlight/docs/raw-ocr-hardening-spec-2026-04-10.md)

Use these docs for:

- OCR phase ordering
- fixture harness expectations
- artifact/debug export requirements
- tuning guidance and rollout rules

## Slabs

- Active cert-first slab rebuild plan: [slab-cert-first-rebuild-implementation-spec-2026-04-11.md](/Users/stephenchan/Code/spotlight/docs/slab-cert-first-rebuild-implementation-spec-2026-04-11.md)
- RN cross-platform ML Kit slab plan: [react-native-ml-kit-psa-slab-plan-2026-04-29.md](/Users/stephenchan/Code/spotlight/docs/react-native-ml-kit-psa-slab-plan-2026-04-29.md)

Use these docs for:

- PSA slab runtime scope
- cert-first resolver behavior
- held-out slab fixture expectations
- RN iOS/Android slab migration planning

## React Native App

- RN scanner normalized target plan: [react-native-scanner-normalized-target-mvp-plan-2026-04-28.md](/Users/stephenchan/Code/spotlight/docs/react-native-scanner-normalized-target-mvp-plan-2026-04-28.md)
- RN migration/context docs:
  - [react-native-universal-migration-spec-2026-04-21.md](/Users/stephenchan/Code/spotlight/docs/react-native-universal-migration-spec-2026-04-21.md)
  - [react-native-parallel-execution-spec-2026-04-21.md](/Users/stephenchan/Code/spotlight/docs/react-native-parallel-execution-spec-2026-04-21.md)
  - [react-native-subagent-execution-spec-2026-04-21.md](/Users/stephenchan/Code/spotlight/docs/react-native-subagent-execution-spec-2026-04-21.md)
- RN design system audit: [rn-design-system-audit-2026-04-26.md](/Users/stephenchan/Code/spotlight/docs/rn-design-system-audit-2026-04-26.md)

Use these docs for:

- current RN scanner assumptions
- RN migration state
- RN design-system cleanup context

## Labeling And Data Pipeline

- Scan data labeling pipeline plan: [scan-data-labeling-pipeline-spec-2026-04-23.md](/Users/stephenchan/Code/spotlight/docs/scan-data-labeling-pipeline-spec-2026-04-23.md)
- Scanner model rewrite plan: [scanner-model-rewrite-spec-2026-04-23.md](/Users/stephenchan/Code/spotlight/docs/scanner-model-rewrite-spec-2026-04-23.md)

Use these docs for:

- labeling UX and admin flow planning
- capture-angle expectations
- export/training split expectations

## Ops, Env, And Release

- Release automation: [release-automation-spec-2026-04-29.md](/Users/stephenchan/Code/spotlight/docs/release-automation-spec-2026-04-29.md)
- Repo asset storage migration: [repo-asset-storage-migration-spec-2026-04-12.md](/Users/stephenchan/Code/spotlight/docs/repo-asset-storage-migration-spec-2026-04-12.md)
- Supabase auth setup: [supabase-auth-phase1-setup-2026-04-19.md](/Users/stephenchan/Code/spotlight/docs/supabase-auth-phase1-setup-2026-04-19.md)

Use these docs for:

- release/deploy workflows
- storage direction
- auth rollout/setup details

## Rule Of Thumb

If the information answers "what is true right now?" rather than "what must always be true?", keep it in `docs/` and link to it from `AGENTS.md` instead of duplicating it there.
