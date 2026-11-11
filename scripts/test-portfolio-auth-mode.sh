#!/bin/sh
set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
resolver=$script_directory/portfolio-auth-mode.sh

assert_mode() {
  branch=$1
  expected=$2
  actual=$(unset PORTFOLIO_AUTH_MODE GITHUB_REF_NAME; PORTFOLIO_BRANCH=$branch "$resolver" print)
  [ "$actual" = "$expected" ] || {
    printf 'expected %s for %s, got %s\n' "$expected" "$branch" "$actual" >&2
    exit 1
  }
}

assert_mode main sso
assert_mode dev local
assert_mode refs/heads/dev local

github_mode=$(unset PORTFOLIO_BRANCH PORTFOLIO_AUTH_MODE; GITHUB_REF_NAME=dev "$resolver" print)
[ "$github_mode" = local ]

if PORTFOLIO_BRANCH=main PORTFOLIO_AUTH_MODE=local "$resolver" check 2>/dev/null; then
  printf '%s\n' 'mismatched explicit mode was accepted' >&2
  exit 1
fi

topic_contract=$(PORTFOLIO_BRANCH=dev PORTFOLIO_AUTH_MODE=local "$resolver" contract)
[ "$topic_contract" = "$(printf 'dev\nlocal')" ]

topic_environment=$(PORTFOLIO_BRANCH=dev PORTFOLIO_AUTH_MODE=local "$resolver" exec -- env)
printf '%s\n' "$topic_environment" | grep -Fqx 'PORTFOLIO_BRANCH=dev'
printf '%s\n' "$topic_environment" | grep -Fqx 'PORTFOLIO_AUTH_MODE=local'

for retired_branch in codex cursor anthropic feature/auth-contract; do
  if PORTFOLIO_BRANCH=$retired_branch PORTFOLIO_AUTH_MODE=local "$resolver" check 2>/dev/null; then
    printf 'retired branch accepted: %s\n' "$retired_branch" >&2
    exit 1
  fi
done
if PORTFOLIO_BRANCH=dev PORTFOLIO_AUTH_MODE=sso "$resolver" check 2>/dev/null; then
  printf '%s\n' 'dev/sso mismatch was accepted' >&2
  exit 1
fi
printf '%s\n' 'portfolio auth mode contract: ok'
