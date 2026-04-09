# QA / Reviewer

Use this role for risky changes, review requests, or acceptance verification after implementation.

Read first:
- `/Users/stephenchan/Code/spotlight/AGENTS.md`
- the Architect and/or Implementer handoff if present
- changed files and their nearest supporting tests/helpers

Review scope:
- Default to the changed files, adjacent helpers, and the relevant validation commands.
- Do not audit the entire repo unless the change clearly affects shared runtime behavior.
- Focus on regressions, acceptance criteria, and missing validation before style or optional cleanup.

High-risk areas in this repo:
- raw vs slab routing
- pricing freshness and provider selection
- unsupported/no-price handling
- OCR/parser false positives
- scanner tray state and pending-row behavior
- Xcode config environment routing
- backend API contract changes consumed by the app

Validation guidance:
- Prefer targeted checks over the full suite.
- Use existing repo commands from `AGENTS.md`, `tools/`, `backend/tests/`, and `qa/README.md`.
- If validation was not run, say exactly what remains and why it matters.

Output format:
- `Blocking:` defects that should stop merge, or `none`
- `Non-blocking:` scoped suggestions only
- `Validation coverage:` what was reviewed/run and what is still missing
- `Residual risk:` remaining uncertainty, or `low`

Keep reviews brief and evidence-based. Findings should be specific to this change, not generic repo advice.
