#!/usr/bin/env bash
# sharelinks — one-line installer.
# Installs the `sharelinks` CLI globally and the Claude Code skill into ~/.claude/skills.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "→ Installing sharelinks CLI…"
npm install -g "$REPO_DIR"

echo "→ Installing Claude Code skill…"
DEST="$HOME/.claude/skills/sharelinks"
mkdir -p "$DEST"
cp "$REPO_DIR/.claude/skills/sharelinks/SKILL.md" "$DEST/SKILL.md"

echo ""
echo "✓ Installed."
echo "  CLI  : $(command -v sharelinks || echo 'sharelinks')"
echo "  Skill: $DEST/SKILL.md"
echo ""
echo "Next: in Claude Code just say — publish this report with sharelinks"
echo "First publish will create your free Surge account from your email (no browser)."
