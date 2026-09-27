#!/usr/bin/env bash
# Spawn a Grok CLI agent in a `git worktree` (not a full clone) of this repo,
# checked out to a new branch off the given base, and launch it non-
# interactively against a story spec.
#
# A worktree is fine for Grok, unlike Codex: Grok runs with no --sandbox flag
# at all (full OS permissions), so it has reliably committed, pushed, and
# opened its own PR unassisted against a worktree checkout in every round so
# far -- the git-worktree commit limitation that forces Claude to commit on
# Codex's behalf (see spawn-codex-agent.sh) is specific to Codex's sandboxed
# subprocess, not to worktrees in general. A worktree shares the main repo's
# object store, so this is cheaper than a clone.
#
# Usage: spawn-grok-agent.sh <branch-name> <base-ref> <dest-dir> <prompt-file> <log-file>
set -euo pipefail
if [ "$#" -ne 5 ]; then
  echo "usage: spawn-grok-agent.sh <branch-name> <base-ref> <dest-dir> <prompt-file> <log-file>" >&2
  exit 2
fi
BRANCH="$1"
BASE="$2"
DEST="$3"
PROMPT_FILE="$4"
LOG_FILE="$5"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(cd "$REPO_ROOT" && git worktree add "$DEST" -b "$BRANCH" "$BASE")

"$HOME/.grok/bin/grok.exe" --prompt-file "$PROMPT_FILE" --cwd "$DEST" \
  --always-approve --permission-mode bypassPermissions --output-format plain \
  > "$LOG_FILE" 2>&1
