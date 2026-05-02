#!/usr/bin/env python3

from __future__ import annotations

import argparse
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = REPO_ROOT / "tmp" / "claude-design" / "claude-design-bundle.md"

DESIGN_SYSTEM_FILES = [
    "packages/design-system/README.md",
    "packages/design-system/src/tokens.ts",
    "packages/design-system/src/theme.tsx",
    "packages/design-system/src/index.ts",
]

PRIMITIVE_FILES = [
    "packages/design-system/src/components/button.tsx",
    "packages/design-system/src/components/icon-button.tsx",
    "packages/design-system/src/components/pill-button.tsx",
    "packages/design-system/src/components/segmented-control.tsx",
    "packages/design-system/src/components/search-field.tsx",
    "packages/design-system/src/components/text-field.tsx",
    "packages/design-system/src/components/screen-header.tsx",
    "packages/design-system/src/components/section-header.tsx",
    "packages/design-system/src/components/sheet-header.tsx",
    "packages/design-system/src/components/state-card.tsx",
    "packages/design-system/src/components/surface-card.tsx",
]

KEY_SCREEN_FILES = [
    "apps/spotlight-rn/src/features/design-system/screens/design-system-catalog-screen.tsx",
    "apps/spotlight-rn/src/features/scanner/screens/scanner-screen.tsx",
    "apps/spotlight-rn/src/features/portfolio/screens/portfolio-screen.tsx",
    "apps/spotlight-rn/src/features/inventory/screens/inventory-browser-screen.tsx",
    "apps/spotlight-rn/src/features/cards/screens/card-detail-screen.tsx",
    "apps/spotlight-rn/src/features/catalog/screens/catalog-search-screen.tsx",
    "apps/spotlight-rn/src/features/collection/screens/add-to-collection-screen.tsx",
]

CLAUDE_CONTEXT_FILES = [
    "CLAUDE.md",
    ".claude/rules/rn-design-system.md",
    ".claude/skills/design-system/SKILL.md",
    "docs/claude-design-system-integration-2026-04-26.md",
    "docs/rn-design-system-audit-2026-04-26.md",
    "docs/claude-design-handoff.md",
]


def read_file(relative_path: str) -> str:
    path = REPO_ROOT / relative_path
    return path.read_text(encoding="utf-8").rstrip()


def format_file_list(paths: list[str]) -> str:
    return "\n".join(f"- `{path}`" for path in paths)


def build_markdown() -> str:
    sections: list[str] = []
    sections.append(
        "# Claude Design Bundle\n\n"
        "This bundle is the fastest repo handoff for Claude to work on Spotlight/Looty UI safely.\n"
    )
    sections.append(
        "## Today Workflow\n\n"
        "1. Start the RN app and open the design-system catalog route.\n"
        "2. Capture 5-8 screenshots of the current app surfaces.\n"
        "3. Give Claude this bundle plus the screenshots.\n"
        "4. Ask for one scoped UI task at a time.\n"
    )
    sections.append(
        "## Launch / Entry Points\n\n"
        "- Design-system route: `spotlight://design-system`\n"
        "- Expo route path: `/design-system`\n"
        "- Generate this bundle: `pnpm claude:design:bundle`\n"
        "- Start design catalog: `pnpm mobile:visual:design`\n"
    )
    sections.append(
        "## Source Of Truth Files\n\n"
        "### Design System\n\n"
        f"{format_file_list(DESIGN_SYSTEM_FILES)}\n\n"
        "### Shared Primitives\n\n"
        f"{format_file_list(PRIMITIVE_FILES)}\n\n"
        "### Key Product Screens\n\n"
        f"{format_file_list(KEY_SCREEN_FILES)}\n\n"
        "### Claude Repo Context\n\n"
        f"{format_file_list(CLAUDE_CONTEXT_FILES)}\n"
    )
    sections.append(
        "## Prompt Template\n\n"
        "```xml\n"
        "<task>[one exact UI task]</task>\n"
        "<design_source>Use the attached screenshots and the local RN design system.</design_source>\n"
        "<repo_context>\n"
        "Read CLAUDE.md, packages/design-system/README.md, packages/design-system/src/tokens.ts,\n"
        "and apps/spotlight-rn/src/features/design-system/screens/design-system-catalog-screen.tsx first.\n"
        "</repo_context>\n"
        "<affected_primitives>[Button, SurfaceCard, SectionHeader, etc]</affected_primitives>\n"
        "<affected_screens>[exact screen paths]</affected_screens>\n"
        "<constraints>\n"
        "- Reuse @spotlight/design-system before creating new primitives\n"
        "- Do not invent new colors, fonts, or spacing scales\n"
        "- Keep scanner on the existing dark scanner theme\n"
        "- Keep portfolio/detail on the existing light theme\n"
        "</constraints>\n"
        "<acceptance>[exact visual / behavior outcome]</acceptance>\n"
        "```\n"
    )
    sections.append(
        "## Screenshot Checklist\n\n"
        "- Design-system catalog\n"
        "- Scanner\n"
        "- Portfolio\n"
        "- Inventory\n"
        "- Card detail\n"
        "- Add Card\n"
        "- One bad/current state if you want Claude to fix a regression\n"
    )

    for relative_path in DESIGN_SYSTEM_FILES + [
        "apps/spotlight-rn/src/features/design-system/screens/design-system-catalog-screen.tsx",
        "CLAUDE.md",
        ".claude/rules/rn-design-system.md",
    ]:
        sections.append(f"## File: `{relative_path}`\n\n```md\n{read_file(relative_path)}\n```\n")

    return "\n".join(sections).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a compact Claude design handoff bundle for this repo.")
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT),
        help="Where to write the markdown bundle. Default: %(default)s",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Print the bundle to stdout instead of writing a file.",
    )
    args = parser.parse_args()

    markdown = build_markdown()
    if args.stdout:
      print(markdown, end="")
      return 0

    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(markdown, encoding="utf-8")
    print(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
