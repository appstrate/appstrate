#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# ci-gate.sh RESULT ACCEPTED... — verdict of a test.yml gate job over the
# `needs.<job>.result` of the matrix it aggregates. Exit 0 iff RESULT is one
# of ACCEPTED, or RESULT is `cancelled` and a newer run of this workflow
# exists for this run's head commit; exit 1 otherwise, 2 on a usage error.
#
# A run superseded by a newer one (same concurrency group, same commit — a
# label added to an open PR) cancels its slices; the newer run reports the
# same check names on the same commit and owns the verdict. Every other
# cancellation fails: a whole run cancelled by hand with nothing after it,
# and a slice cancelled in a live run (`timeout-minutes` expiry, a runner
# never acquired), so a suite that never finished is never a passing check.
# `cancelled()` cannot tell them apart here: a gate job that starts after its
# run was cancelled still runs its default-`success()` steps.
#
# Needs gh and jq (GitHub-hosted runners ship both), GH_TOKEN with
# `actions: read`, and the runner's GITHUB_REPOSITORY and GITHUB_RUN_ID.

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

# The run's own head_sha is the commit its checks attach to, whatever the
# event (a pull_request's head, not the merge commit in GITHUB_SHA).
run=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID")
workflow_id=$(jq -r '.workflow_id' <<<"$run")
head_sha=$(jq -r '.head_sha' <<<"$run")
run_number=$(jq -r '.run_number' <<<"$run")

newer=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/$workflow_id/runs?head_sha=$head_sha&per_page=100" |
  jq -r --argjson n "$run_number" \
    '[.workflow_runs[] | select(.run_number > $n)] | sort_by(.run_number) | last | .html_url // empty')

if [ -n "$newer" ]; then
  echo "::notice::upstream jobs cancelled; superseded by $newer, which reports this check for $head_sha"
  exit 0
fi

echo "::error::upstream jobs cancelled, and no newer run of this workflow exists for $head_sha"
exit 1
