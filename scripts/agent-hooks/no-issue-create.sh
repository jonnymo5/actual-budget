#!/bin/sh
# Shared agent guard prohibiting GitHub issue creation, wired for Claude
# (PreToolUse), Codex (PreToolUse) and Cursor (beforeMCPExecution via adapter).
#
# Agents may only create GitHub issues on the user's own fork
# (jonnymo5/actual-budget), never on upstream or any other repo
# (.github/agents/pr-and-commit-rules.md). Runs on the github MCP issue writer
# (issue_write, which multiplexes create/update via `.tool_input.method`) and
# blocks everything except updates to existing issues and creates targeting the
# fork (exit 2 + stderr feeds the reason back to the agent). `gh issue create`
# from the shell is checked separately by git-guard.sh.

block() {
  echo "$1" >&2
  exit 2
}

# A missing jq gets its own actionable block, distinct from the
# malformed-payload block below.
. "$(dirname "$0")/common.sh"
require_jq

# Fail closed on a malformed payload — invalid JSON, or a missing/non-object
# `.tool_input` — matching the other guards, so a payload we can't read can't
# silently bypass the check. A valid payload with no method yields "" and is
# caught by the allowlist below.
payload=$(cat)
method=$(printf '%s' "$payload" | jq -re '.tool_input | objects | .method // ""' 2>/dev/null) ||
  block "Blocked: could not read the hook payload (.tool_input). (scripts/agent-hooks/no-issue-create.sh)"

# Allowlist rather than denylist: only updates to existing issues pass, so an
# unknown or missing method fails closed instead of slipping past as a create
# by another name.
case "$method" in
  update) exit 0 ;;
  create)
    target=$(printf '%s' "$payload" | jq -r '.tool_input | "\(.owner // "")/\(.repo // "")"' 2>/dev/null)
    [ "$target" = "jonnymo5/actual-budget" ] && exit 0
    block "Blocked: agents may only create GitHub issues on the user's fork (owner jonnymo5, repo actual-budget), not '${target}' (.github/agents/pr-and-commit-rules.md). Share the proposed issue title and body with the user instead." ;;
  *)
    block "Blocked: unrecognized issue_write method '${method:-<missing>}' — agents may only update existing issues, never create them (.github/agents/pr-and-commit-rules.md). If this is a new non-create method, extend the allowlist in scripts/agent-hooks/no-issue-create.sh." ;;
esac
