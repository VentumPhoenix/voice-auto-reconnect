#!/usr/bin/env bash
# Updates Vencord and the VoiceAutoReconnect plugin, builds Vencord and injects it into Discord.
#
#   scripts/update.sh [--vencord-dir DIR] [--no-inject] [--skip-plugin-pull]
#
# Default Vencord directory: $VENCORD_DIR or ~/Vencord
# Requires git, Node.js >= 22 and pnpm (https://pnpm.io/installation).
set -euo pipefail

VENCORD_DIR="${VENCORD_DIR:-$HOME/Vencord}"
INJECT=1
PULL_PLUGIN=1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --vencord-dir) VENCORD_DIR="$2"; shift 2 ;;
        --no-inject) INJECT=0; shift ;;
        --skip-plugin-pull) PULL_PLUGIN=0; shift ;;
        -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

for tool in git node pnpm; do
    command -v "$tool" >/dev/null 2>&1 || { echo "'$tool' was not found on PATH. Install it first (see README)." >&2; exit 1; }
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_SRC="$REPO_ROOT/src/voiceAutoReconnect"

if [[ $PULL_PLUGIN -eq 1 && -d "$REPO_ROOT/.git" ]]; then
    echo "==> Updating plugin repository"
    git -C "$REPO_ROOT" pull --ff-only
fi

if [[ -d "$VENCORD_DIR/.git" ]]; then
    echo "==> Updating Vencord in $VENCORD_DIR"
    git -C "$VENCORD_DIR" pull --ff-only
else
    echo "==> Cloning Vencord into $VENCORD_DIR"
    git clone https://github.com/Vendicated/Vencord.git "$VENCORD_DIR"
fi

PLUGIN_DST="$VENCORD_DIR/src/userplugins/voiceAutoReconnect"
echo "==> Copying plugin to $PLUGIN_DST"
rm -rf "$PLUGIN_DST"
mkdir -p "$(dirname "$PLUGIN_DST")"
cp -r "$PLUGIN_SRC" "$PLUGIN_DST"

echo "==> Installing dependencies and building Vencord"
cd "$VENCORD_DIR"
pnpm install --frozen-lockfile
pnpm build

if [[ $INJECT -eq 1 ]]; then
    echo "==> Injecting Vencord (the installer will ask which Discord install to patch)"
    pnpm inject
    echo "Done. Fully restart Discord, then enable VoiceAutoReconnect in Settings > Vencord > Plugins."
else
    echo "Build finished. Skipped injection (--no-inject). Restart Discord to load the new build."
fi
