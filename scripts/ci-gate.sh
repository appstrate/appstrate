#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# ci-gate.sh RESULT ACCEPTED... — verdict of a test.yml gate job over the
# `needs.<job>.result` of the matrix it aggregates. Exit 0 iff RESULT is one
# of ACCEPTED, or RESULT is `cancelled` and a newer run of this workflow
# exists for this run's head commit; exit 1 otherwise, 2 on a usage error.
# That newer run reports the same checks on the same commit, so it owns the
# verdict; any other cancellation (by hand, timeout) stays a failure.

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <result> <accepted-result>..." >&2
  exit 2
fi

result=$1
shift
for accepted in "$@"; do
  if [ "$result" = "$accepted" ]; then exit 0; fi
done

if [ "$result" != cancelled ]; then
  echo "::error::upstream jobs: $result"
  exit 1
fi

: "${GITHUB_REPOSITORY:?}" "${GITHUB_RUN_ID:?}"
[[ "${GITHUB_RUN_NUMBER:?}" =~ ^[0-9]+$ ]] || exit 2

run=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --jq '"\(.workflow_id) \(.head_sha)"')
read -r workflow_id head_sha <<<"$run"

newer=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/$workflow_id/runs?head_sha=$head_sha&per_page=100" \
  --jq "[.workflow_runs[] | select(.run_number > $GITHUB_RUN_NUMBER)] | sort_by(.run_number) | last | .html_url // empty")

if [ -n "$newer" ]; then
  echo "::notice::upstream jobs cancelled; superseded by $newer, which reports this check for $head_sha"
  exit 0
fi

echo "::error::upstream jobs cancelled, and no newer run of this workflow exists for $head_sha"
exit 1
