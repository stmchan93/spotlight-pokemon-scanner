# Claude Design Handoff

Date: 2026-04-30

This repo already has the Claude-specific rules and RN design-system structure. The missing piece was a practical workflow for using them quickly.

This document is that workflow.

## What Is Ready

- Root Claude repo entrypoint:
  - [CLAUDE.md](/Users/stephenchan/Code/spotlight/CLAUDE.md)
- Path-scoped RN design-system rules:
  - [.claude/rules/rn-design-system.md](/Users/stephenchan/Code/spotlight/.claude/rules/rn-design-system.md)
- Reusable design-system skill:
  - [.claude/skills/design-system/SKILL.md](/Users/stephenchan/Code/spotlight/.claude/skills/design-system/SKILL.md)
- Design-system package:
  - [packages/design-system/README.md](/Users/stephenchan/Code/spotlight/packages/design-system/README.md)
  - [packages/design-system/src/tokens.ts](/Users/stephenchan/Code/spotlight/packages/design-system/src/tokens.ts)
  - [packages/design-system/src/components](/Users/stephenchan/Code/spotlight/packages/design-system/src/components)
- Live RN design-system catalog screen:
  - [apps/spotlight-rn/src/features/design-system/screens/design-system-catalog-screen.tsx](/Users/stephenchan/Code/spotlight/apps/spotlight-rn/src/features/design-system/screens/design-system-catalog-screen.tsx)
- Project-scoped MCP config:
  - [.mcp.json](/Users/stephenchan/Code/spotlight/.mcp.json)
  - includes `figma-dev-mode` and `posthog`

## One-Command Workflow

### Build the Claude handoff bundle

```bash
pnpm claude:design:bundle
```

This writes:

- `tmp/claude-design/claude-design-bundle.md`

The bundle includes:

- the design-system source-of-truth files
- the Claude rule files
- the design-system catalog screen
- a prompt template
- a screenshot checklist

### Start the RN design catalog

```bash
pnpm mobile:visual:design
```

That script starts Expo from `apps/spotlight-rn` and prints the route info you need.

Primary route:

- deep link: `spotlight://design-system`
- Expo route path: `/design-system`

## What To Give Claude

Do not dump the whole app history or every screenshot you have.

Give Claude:

1. `tmp/claude-design/claude-design-bundle.md`
2. `5-8` screenshots max
3. one exact task

Recommended screenshots:

- design-system catalog
- scanner
- portfolio
- inventory
- card detail
- add card
- one current bad state if there is a regression

## Source Of Truth

For shared UI decisions, Claude should treat these as authoritative:

- `packages/design-system/src/tokens.ts`
- `packages/design-system/src/theme.tsx`
- `packages/design-system/src/components/*.tsx`
- `packages/design-system/README.md`

For screen implementation, Claude should read only the screens you name in the task.

Recommended first screens:

- `apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx`
- `apps/spotlight-rn/src/features/portfolio/screens/portfolio-screen.tsx`
- `apps/spotlight-rn/src/features/inventory/screens/inventory-browser-screen.tsx`
- `apps/spotlight-rn/src/features/cards/screens/card-detail-screen.tsx`
- `apps/spotlight-rn/src/features/collection/screens/add-to-collection-screen.tsx`

## Prompt Shape

Use this shape:

```xml
<task>[one exact UI task]</task>
<design_source>Use the attached screenshots and the local RN design system.</design_source>
<repo_context>
Read CLAUDE.md, packages/design-system/README.md, packages/design-system/src/tokens.ts,
and apps/spotlight-rn/src/features/design-system/screens/design-system-catalog-screen.tsx first.
</repo_context>
<affected_primitives>[Button, SurfaceCard, SectionHeader, etc]</affected_primitives>
<affected_screens>[exact screen paths]</affected_screens>
<constraints>
- Reuse @spotlight/design-system before creating new primitives
- Do not invent new colors, fonts, or spacing scales
- Keep scanner on the existing dark scanner theme
- Keep portfolio/detail on the existing light theme
</constraints>
<acceptance>[exact visual / behavior outcome]</acceptance>
```

## Operator Notes

- Prefer one task at a time.
- Prefer code context plus screenshots over screenshots alone.
- If the work is primitive-level, point Claude at `packages/design-system` first.
- If the work is a screen-only exception, say that explicitly.
