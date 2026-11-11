#!/bin/sh
set -eu
script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
branch=$(git -C "$script_directory/.." branch --show-current)
[ "$branch" = dev ] || {
  printf '%s\n' 'Local development must run from the dev branch; fetch origin/main and switch to dev first.' >&2
  exit 1
}
