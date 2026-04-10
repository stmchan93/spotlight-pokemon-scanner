# OCR Golden Outputs

This directory is reserved for fixture-runner outputs and golden comparison
artifacts.

Current subtrees:

- `phase2-baseline/`
  - host-side manifest validation and copied-image baseline output
- `simulator-legacy-v1/`
  - simulator-backed execution of the current legacy OCR analyzers
- `simulator-rewrite-v1-raw-stage2/`
  - simulator-backed execution of the rewrite raw branch with selective escalation and field-confidence output

Future side-by-side runs should continue writing stable per-fixture outputs here
for:

- legacy OCR
- rewritten OCR
- diff reports
