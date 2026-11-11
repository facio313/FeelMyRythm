#!/bin/sh
set -eu
script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT HUP INT TERM
git -C "$fixture" init --quiet --initial-branch=main
mkdir "$fixture/scripts"
cp "$script_directory/require-dev.sh" "$fixture/scripts/require-dev.sh"
if PORTFOLIO_BRANCH=dev GITHUB_REF_NAME=dev sh "$fixture/scripts/require-dev.sh" 2>/dev/null; then
  printf '%s\n' 'main checkout accepted a dev environment override' >&2
  exit 1
fi
git -C "$fixture" symbolic-ref HEAD refs/heads/dev
sh "$fixture/scripts/require-dev.sh"
printf '%s\n' 'local dev checkout guard: ok'
