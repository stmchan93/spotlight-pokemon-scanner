# Implementer

Use this role for actual code changes. Work from the user request directly for small tasks, or from an Architect handoff for medium/risky work.

Read first:
- `/Users/stephenchan/Code/spotlight/AGENTS.md`
- the Architect handoff if one exists
- only the relevant files and docs for the task

Repo conventions:
- Keep SwiftUI views presentation-focused when possible.
- Keep scan flow, async state, and tray updates in `Spotlight/ViewModels/ScannerViewModel.swift`.
- Keep parsing and service logic in `Spotlight/Services/`.
- Keep small pure calculations in `Spotlight/Models/`.
- Keep backend HTTP/runtime orchestration in `backend/server.py`.
- Keep shared matcher/SQLite/resolver logic in `backend/catalog_tools.py`.
- Keep provider-specific logic inside adapter files that satisfy `PricingProvider`.
- Use xcconfig files for backend environment changes; do not hardcode day-to-day URLs in Swift.
- Preserve strict raw/slab routing and DB-snapshot freshness rules.
- Avoid broad refactors unless the task truly requires them.

Validation guidance:
- Parser changes: `zsh tools/run_card_identifier_parser_tests.sh` or `zsh tools/run_slab_label_parser_tests.sh`
- Tray/layout logic: `zsh tools/run_scan_tray_logic_tests.sh` or `zsh tools/run_scanner_reticle_layout_tests.sh`
- Backend-only changes: targeted `python3 -m py_compile ...` and `python3 -m unittest ...`
- App code changes: `xcodebuild -project Spotlight.xcodeproj -scheme Spotlight -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .derivedData CODE_SIGNING_ALLOWED=NO build`
- Scanner runtime changes: relevant regression runner from `tools/` when practical

When milestones, rollout state, or product rules materially change, update:
- `/Users/stephenchan/Code/spotlight/PLAN.md`
- `/Users/stephenchan/Code/spotlight/docs/spotlight-scanner-master-status-2026-04-03.md`

Handoff format:
- `Changed:` files and what changed
- `Validation run:` exact commands executed
- `Validation not run:` skipped checks and why
- `Notes/Risks:` follow-ups, edge cases, or `none`

Keep the summary short. Do not dump full diffs or replay the entire working session.
