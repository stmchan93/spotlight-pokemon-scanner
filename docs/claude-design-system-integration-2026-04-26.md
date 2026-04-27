# Claude Design System Integration Guide

Date: 2026-04-26

This document explains how to make the RN design system easy for Claude Code and Claude-connected design workflows to understand and modify.

## Research Summary

Official Anthropic guidance suggests five useful mechanisms for this repo:

1. `CLAUDE.md` for persistent project instructions.
2. `.claude/rules/` for modular and path-scoped rules.
3. `.claude/skills/` for reusable procedures or prompt playbooks that should not load every session.
4. MCP for external design tools such as Figma.
5. XML tags for structured prompts when prompts mix instructions, context, examples, and constraints.

Official sources:

- Claude memory and `CLAUDE.md`: https://code.claude.com/docs/en/memory
- Claude skills: https://code.claude.com/docs/en/slash-commands
- Claude MCP: https://code.claude.com/docs/en/mcp
- Anthropic prompt XML guidance: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#structure-prompts-with-xml-tags
- Anthropic product-design usage example: https://claude.com/blog/how-anthropic-teams-use-claude-code

## What Claude Will Understand Best

Claude will understand the design system most reliably when:

- there is one package for shared primitives
- tokens live in one obvious file
- component exports are centralized
- prop names are descriptive and stable
- instructions are concise and path-scoped
- repeated workflows are captured as skills instead of buried in giant root instructions
- prompts separate:
  - task
  - context
  - examples
  - constraints
  - acceptance criteria

For interactive control consistency specifically, Claude should be able to infer one rule quickly:

- tappable labels should default to `typography.control`
- helper/meta labels should stay on `caption` or `micro`
- feature screens should not silently choose between `body`, `bodyStrong`, and `caption` for controls
- scanner is a distinct surface, but not a separate design language; its dark-mode-specific colors and control treatments should still live in shared tokens and primitive variants

## Repo Implementation

This repo now supports that structure through:

- `CLAUDE.md`
  - Claude-specific project entrypoint
  - imports `AGENTS.md` so Claude can see the existing project guidance
- `.claude/rules/rn-design-system.md`
  - path-scoped guidance for RN and design-system files
- `.claude/skills/design-system/SKILL.md`
  - reusable design-system workflow/prompt playbook
- `packages/design-system/README.md`
  - source-of-truth component and token map for Claude and humans
- `docs/rn-design-system-audit-2026-04-26.md`
  - current audit and migration direction

## MCP Recommendation

For design ingestion, the best-supported path is Figma via MCP.

Anthropic’s Claude Code MCP docs explicitly list design integration with Figma as a supported workflow and document project-scoped MCP configuration in `.mcp.json`.

Recommended workflow:

1. Run the Figma Dev Mode MCP server locally.
2. Keep a project-scoped `.mcp.json` in the repo for team-shared server config.
3. Ask Claude to read both:
   - the Figma design context
   - the local design-system package
4. Instruct Claude to:
   - map repeated patterns to shared primitives
   - prefer token changes before screen-local overrides

## Prompt Shape Recommendation

When using Claude for design-system changes, structure prompts with XML-style sections:

```xml
<task></task>
<design_source></design_source>
<repo_context></repo_context>
<affected_tokens></affected_tokens>
<affected_primitives></affected_primitives>
<affected_screens></affected_screens>
<constraints></constraints>
<acceptance></acceptance>
```

Why:

- Anthropic’s prompt docs recommend XML tags for separating complex prompt parts clearly.
- This reduces ambiguity when a request mixes design intent, codebase constraints, and migration instructions.

## Recommended Prompt Templates

### Primitive Change

```xml
<task>Update the shared RN button primitive and migrate callers.</task>
<repo_context>Use packages/design-system as the source of truth for shared primitives.</repo_context>
<affected_primitives>Button</affected_primitives>
<affected_screens>portfolio, inventory, sales history</affected_screens>
<constraints>Do not introduce new one-off fontWeight overrides in screens.</constraints>
<acceptance>All affected screens use the shared primitive and focused tests are updated.</acceptance>
```

### Figma-to-Primitive Translation

```xml
<task>Translate the repeated Figma patterns into RN shared primitives.</task>
<design_source>Figma Dev Mode MCP</design_source>
<repo_context>Read packages/design-system/README.md and docs/rn-design-system-audit-2026-04-26.md first.</repo_context>
<affected_tokens>colors, spacing, typography</affected_tokens>
<affected_primitives>SearchField, SectionHeader, StateCard</affected_primitives>
<constraints>Prefer changing tokens and shared primitives before editing screen-local styles.</constraints>
<acceptance>Resulting changes reduce repeated UI code across RN screens.</acceptance>
```

### Audit Prompt

```xml
<task>Audit the RN app for design-system drift.</task>
<repo_context>Compare apps/spotlight-rn against packages/design-system.</repo_context>
<focus_areas>buttons, headers, text inputs, state cards, typography overrides</focus_areas>
<output_format>List repeated patterns, recommend primitive ownership, then implement the smallest high-value migration slice.</output_format>
```

## Design-System Authoring Rules For Claude

- modify shared tokens before patching multiple screens
- keep interactive label styling centralized on `typography.control` unless the design system explicitly defines a different control tier
- keep scanner-specific dark surfaces centralized in shared scanner color tokens rather than repeated screen-local literals
- prefer named variants over hidden local style mutations
- preserve primitive readability from filenames and prop names alone
- keep foundational primitives in `packages/design-system`
- keep feature-specific composites in `apps/spotlight-rn`
- update documentation when a primitive contract changes

## Decision

The design system should be optimized for Claude by:

- keeping a small, explicit primitive surface
- documenting ownership clearly
- using `CLAUDE.md` plus path-scoped rules for persistent context
- using a project skill for multi-step design-system work
- using MCP for design ingestion
- using XML-structured prompts for ambiguous or design-heavy requests
