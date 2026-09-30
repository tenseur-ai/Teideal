#!/usr/bin/env bash
# Spawn a Codex CLI agent in a `git worktree` of this repo, checked out to a
# new branch off the given base, and launch it non-interactively against a
# story spec.
#
# Codex's `--sandbox workspace-write` process cannot commit its own work,
# full stop -- confirmed on a worktree checkout (twice, on two different
# stories, even with `--add-dir` explicitly granting the worktree's real
# `.git` directory) AND on a full clone whose `.git` is entirely
# self-contained inside the sandboxed workdir (a normal file at the clone
# root was created without issue; `.git/index.lock` still got "Permission
# denied"). That rules out "the worktree's .git lives outside the sandbox"
# as the cause -- this looks like Codex's sandbox denylisting `.git` paths
# specifically, regardless of `--sandbox workspace-write`'s general workdir
# grant, most likely on purpose (stopping a sandboxed agent from touching
# version-control internals directly). There is no known configuration fix;
# don't spend time re-discovering this. Claude reviews Codex's diff and
# commits it after the run, every time, on this platform -- this is now a
# permanent step in the process, not a workaround to eventually remove.
# A worktree is used here (not a clone) since it shares the main repo's
# object store and there's no longer a reason to pay a clone's extra disk
# cost when it doesn't fix anything.
#
# What this script DOES fix: npm's cache is pinned to a workdir-local path
# via the npm_config_cache environment variable (not a .npmrc file) -- npm
# only reads a project .npmrc from the exact current working directory, not
# parent directories, so a .npmrc at the worktree root does not help npm
# install running inside a nested tests/<name>/ directory with its own
# package.json (this bit Codex on both TEID-44 and TEID-94). An env var
# applies to every npm invocation in the whole process tree regardless of
# cwd depth, so this class of failure shouldn't recur.
#
# Usage: spawn-codex-agent.sh <branch-name> <base-ref> <dest-dir> <prompt-file> <log-file>
set -euo pipefail
if [ "$#" -ne 5 ]; then
  echo "usage: spawn-codex-agent.sh <branch-name> <base-ref> <dest-dir> <prompt-file> <log-file>" >&2
  exit 2
fi
BRANCH="$1"
BASE="$2"
DEST="$3"
PROMPT_FILE="$4"
LOG_FILE="$5"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(cd "$REPO_ROOT" && git worktree add "$DEST" -b "$BRANCH" "$BASE")

# Normalize DEST to a POSIX path (Git Bash's `pwd`), regardless of whether the
# caller passed a Windows-style (backslash) or POSIX-style path. This matters
# because NPM_CACHE_DIR gets embedded inside a double-quoted TOML string
# below (the `-c shell_environment_policy.set=...` argument) -- TOML basic
# strings treat backslash as an escape character, so a raw Windows path like
# `C:\Users\kiran\...` silently corrupts that argument (`\t` becomes a tab
# escape, etc.), and codex then fails with "invalid type: string ..., expected
# a map" because it can no longer parse the value as an inline table at all.
# Confirmed this exact failure mode once (TEID-48's first spawn attempt);
# normalizing DEST up front avoids it regardless of which path style a future
# caller passes.
DEST="$(cd "$DEST" && pwd)"

CACHE_ROOT="$(cd "$(dirname "$DEST")" && pwd)"
GOCACHE_DIR="$CACHE_ROOT/.gocache"
GOMODCACHE_DIR="$CACHE_ROOT/.gomodcache"
NPM_CACHE_DIR="$DEST/.npm-cache"
mkdir -p "$GOCACHE_DIR" "$GOMODCACHE_DIR" "$NPM_CACHE_DIR"

codex exec -C "$DEST" -s workspace-write \
  -c "shell_environment_policy.set={GOCACHE=\"$GOCACHE_DIR\", GOMODCACHE=\"$GOMODCACHE_DIR\", npm_config_cache=\"$NPM_CACHE_DIR\"}" \
  -o "${LOG_FILE%.txt}-lastmsg.txt" \
  - < "$PROMPT_FILE" > "$LOG_FILE" 2>&1
