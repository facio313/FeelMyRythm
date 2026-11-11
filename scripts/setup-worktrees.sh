#!/usr/bin/env bash
# Prepare the shared dev branch without removing any existing worktree or local data.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
git fetch origin refs/heads/main:refs/remotes/origin/main
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Preserve and commit the current changes before switching or integrating dev." >&2
  exit 1
fi
if git show-ref --verify --quiet refs/heads/dev; then
  git switch dev
elif git show-ref --verify --quiet refs/remotes/origin/dev; then
  git switch --track -c dev origin/dev
else
  git switch -c dev origin/main
fi
git merge --no-edit origin/main
printf '%s\n' 'Ready: dev for local development; main is the production baseline.'
