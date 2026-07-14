#!/usr/bin/env bash
# sharelinks — one-line installer.
# Installs the `sharelinks` CLI globally and the Claude Code skill into ~/.claude/skills.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "→ Installing sharelinks CLI…"
if ! npm install -g "$REPO_DIR" >/dev/null 2>&1; then
  # Global prefix not writable (common when Node lives in /usr/local). Fall back
  # to a user-level prefix and put it on PATH — no sudo required.
  echo "  (global dir needs sudo; installing to ~/.npm-global instead)"
  npm config set prefix "$HOME/.npm-global"
  npm install -g "$REPO_DIR"
  BIN="$HOME/.npm-global/bin"
  case ":$PATH:" in *":$BIN:"*) : ;; *)
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      [ -e "$rc" ] || continue
      grep -qF '.npm-global/bin' "$rc" 2>/dev/null && continue
      printf '\n# user-global npm binaries (sharelinks)\nexport PATH="%s:$PATH"\n' "$BIN" >> "$rc"
    done
    export PATH="$BIN:$PATH"
    echo "  Added ~/.npm-global/bin to PATH (restart your shell if 'sharelinks' isn't found)."
  ;; esac
fi

echo "→ Installing Claude Code skill…"
SKILL_DEST="$HOME/.claude/skills/sharelinks"
mkdir -p "$SKILL_DEST"
cp "$REPO_DIR/.claude/skills/sharelinks/SKILL.md" "$SKILL_DEST/SKILL.md"

echo "→ Installing /sharelinks slash command…"
mkdir -p "$HOME/.claude/commands"
cp "$REPO_DIR/.claude/commands/sharelinks.md" "$HOME/.claude/commands/sharelinks.md"

echo "→ Installing suggest-publish hook…"
mkdir -p "$HOME/.claude/hooks"
HOOK_DEST="$HOME/.claude/hooks/sharelinks-suggest-publish.js"
cp "$REPO_DIR/hooks/suggest-publish.js" "$HOOK_DEST"

# The auto-suggest hook is opt-in: pass --suggest to enable it globally.
NODE_BIN="$(command -v node)"
if [ "${1:-}" = "--suggest" ]; then
  node "$REPO_DIR/hooks/register.js" "$HOME/.claude/settings.json" "\"$NODE_BIN\" \"$HOOK_DEST\""
  HOOK_STATUS="enabled globally (Claude will offer to publish new reports)"
else
  HOOK_STATUS="installed but OFF — enable with: bash install.sh --suggest"
fi

echo ""
echo "✓ Installed."
echo "  CLI    : $(command -v sharelinks || echo 'sharelinks')"
echo "  Skill  : $SKILL_DEST/SKILL.md"
echo "  Command: /sharelinks"
echo "  Hook   : $HOOK_STATUS"
echo ""
echo "Next: in Claude Code say  /sharelinks ./report.html   — or just — publish this report with sharelinks"
echo "First publish creates your free Surge account from your email (no browser)."
