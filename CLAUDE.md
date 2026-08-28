@AGENTS.md

## Claude Code

- For React Native design-system work, follow the path-scoped rule in `.claude/rules/rn-design-system.md`.
- For multi-step design-system audits or primitive refactors, use the project skill in `.claude/skills/design-system/SKILL.md`.
- The current RN design-system audit and migration source of truth is `docs/rn-design-system-audit-2026-04-26.md`.
- The Claude-specific design-system integration guide is `docs/claude-design-system-integration-2026-04-26.md`.
- The practical operator handoff for today is `docs/claude-design-handoff.md`.
- Generate the current Claude design bundle with `python3 tools/build_claude_design_handoff.py`.
- Start the RN design catalog with `pnpm --filter @spotlight/mobile-app visual:design`.

## Figma visual sync (`/sync-design`)

- **Figma is the source of truth for visual values** (spacing, typography, colors, radii). `design-map.json` at the repo root is the screen ↔ Figma-node registry; keep it updated when screens or Figma frames move.
- `/sync-design <figma-node-url>` is the workflow: numeric pass against the Figma spec first, then simulator-screenshot vs Figma-export pixel diff. Full loop in `.claude/commands/sync-design.md`.
- Shared visual values live in `packages/design-system/src/tokens.ts`. **Never hardcode a value that exists as a token** — when Figma disagrees with a token, fix the token, not the call site.
- Deterministic screenshot rendering: launch Metro with `EXPO_PUBLIC_DEV_SCREENS=1`, then open `spotlight://dev/<screen>` (registry: `apps/spotlight-rn/src/dev/dev-screen-host.tsx`, mock data: `apps/spotlight-rn/src/dev/dev-repository.ts`).
- Tooling in `tools/design-sync/`: `screenshot.sh` (simulator capture, pinned status bar), `figma-export.js` (REST PNG export, needs `FIGMA_TOKEN`, exits 2 without one), `visual-diff.js` (pixelmatch %, default threshold 3%). Artifacts land in `.design-sync/` (gitignored).
