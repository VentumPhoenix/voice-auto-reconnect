#!/usr/bin/env bash
# Opens/updates (on failure) or closes (on success) the single "compat" tracking issue.
# Expects: GH_TOKEN, GITHUB_REPOSITORY, OUTCOME, VENCORD_SHA, RUN_URL
set -euo pipefail

REPO="${GITHUB_REPOSITORY:?}"
LABEL="compat"
TITLE="Incompatible with current Vencord main"
SHA="${VENCORD_SHA:-}"
if [[ -z "$SHA" ]]; then SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"; fi
SHA_LINK="[\`${SHA:0:12}\`](https://github.com/Vendicated/Vencord/commit/$SHA)"

EXISTING="$(gh issue list --repo "$REPO" --label "$LABEL" --state open --json number --jq '.[0].number // empty' 2>/dev/null || true)"

case "${OUTCOME:-}" in
    success)
        if [[ -n "$EXISTING" ]]; then
            gh issue close "$EXISTING" --repo "$REPO" \
                --comment "Fixed: the compatibility check passes again against Vencord $SHA_LINK. Run: $RUN_URL"
            echo "Closed issue #$EXISTING"
        else
            echo "No open compat issue, nothing to do."
        fi
        ;;
    *)
        BODY="The daily compatibility check failed against Vencord main.

- Outcome: \`${OUTCOME:-unknown}\`
- Vencord commit: $SHA_LINK
- Run: $RUN_URL

This issue is closed automatically once the check passes again."

        gh label create "$LABEL" --repo "$REPO" --color "d93f0b" \
            --description "Compatibility with Vencord / Discord" 2>/dev/null || true

        if [[ -n "$EXISTING" ]]; then
            gh issue comment "$EXISTING" --repo "$REPO" --body "$BODY"
            echo "Updated issue #$EXISTING"
        else
            gh issue create --repo "$REPO" --title "$TITLE" --label "$LABEL" --body "$BODY"
        fi
        ;;
esac
