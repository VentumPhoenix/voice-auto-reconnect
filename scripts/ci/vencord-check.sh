#!/usr/bin/env bash
# Builds, type-checks and lints this plugin inside a Vencord checkout.
# Used by both CI workflows and runnable locally:
#
#   scripts/ci/vencord-check.sh <path-to-vencord-checkout>
#
# Script names come from Vencord's package.json:
#   test:ts   -> tsc --noEmit
#   lint      -> eslint
#   build     -> desktop build (run with --standalone like Vencord's own CI)
#   buildWeb  -> browser build (buildWebStandalone)
set -euo pipefail

VENCORD_DIR="$(cd "${1:?usage: vencord-check.sh <vencord-dir>}" && pwd)"
PLUGIN_SRC="$(cd "$(dirname "$0")/../../src/voiceAutoReconnect" && pwd)"
PLUGIN_DST="$VENCORD_DIR/src/userplugins/voiceAutoReconnect"
PLUGIN_REL="src/userplugins/voiceAutoReconnect"

summary() {
    # Writes to the GitHub job summary when available, otherwise to stdout.
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then echo "$*" >> "$GITHUB_STEP_SUMMARY"; else echo "$*"; fi
}

cd "$VENCORD_DIR"
VENCORD_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
echo "Vencord commit: $VENCORD_SHA"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "vencord_sha=$VENCORD_SHA" >> "$GITHUB_OUTPUT"; fi
summary "### Vencord compatibility check"
summary "Vencord commit: \`$VENCORD_SHA\`"

echo "::group::Copy plugin"
rm -rf "$PLUGIN_DST"
mkdir -p "$(dirname "$PLUGIN_DST")"
cp -r "$PLUGIN_SRC" "$PLUGIN_DST"
ls -la "$PLUGIN_DST"
echo "::endgroup::"

echo "::group::pnpm install"
pnpm install --frozen-lockfile
echo "::endgroup::"

echo "::group::Typecheck (pnpm test:ts)"
# Vencord's tsc covers the whole repo. Only fail if errors touch our plugin, so an
# unrelated breakage on Vencord main is reported as a warning instead of a false alarm.
set +e
pnpm test:ts > tsc.log 2>&1
TSC_EXIT=$?
set -e
cat tsc.log
if [[ $TSC_EXIT -ne 0 ]]; then
    if grep -q "$PLUGIN_REL" tsc.log; then
        echo "::error::TypeScript errors in the plugin (see log above)"
        summary "- Typecheck: **failed** (errors in plugin)"
        exit 1
    fi
    echo "::warning::Vencord main has TypeScript errors unrelated to this plugin"
    summary "- Typecheck: plugin ok, unrelated errors on Vencord main"
else
    summary "- Typecheck: ok"
fi
echo "::endgroup::"

echo "::group::Lint (pnpm lint $PLUGIN_REL)"
pnpm lint "$PLUGIN_REL"
summary "- Lint: ok"
echo "::endgroup::"

echo "::group::Build desktop (pnpm build --standalone)"
pnpm build --standalone
summary "- Desktop build: ok"
echo "::endgroup::"

echo "::group::Build web (pnpm buildWebStandalone)"
pnpm buildWebStandalone
summary "- Web build: ok"
echo "::endgroup::"

# Make sure the plugin actually ended up in the bundle.
if ! grep -rqs "VoiceAutoReconnect" dist/; then
    echo "::error::Plugin not found in build output"
    summary "- Bundle check: **failed**"
    exit 1
fi
summary "- Bundle contains plugin: ok"
echo "All Vencord checks passed."
