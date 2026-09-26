#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# semver-lt.sh A B — exit 0 iff release tag A < tag B, 1 otherwise, 2 on a
# usage error, a malformed tag or a dpkg failure. Tags are vX.Y.Z[-pre].
#
# Used by publish-installer.yml to keep the "latest" channel monotonic;
# table-tested in test-install.yml. Needs dpkg (Debian/Ubuntu runners).

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <tag-a> <tag-b>" >&2
  exit 2
fi

# A missing dpkg must not read as "not lower" — callers would promote blindly.
if ! command -v dpkg >/dev/null 2>&1; then
  echo "semver-lt: dpkg is required" >&2
  exit 2
fi

tag_re='^v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9._]+)?$'
for tag in "$1" "$2"; do
  if ! [[ "$tag" =~ $tag_re ]]; then
    echo "semver-lt: invalid tag '$tag' (expected vMAJOR.MINOR.PATCH[-prerelease])" >&2
    exit 2
  fi
done

# dpkg sorts `~` before everything, even the end of the string, so mapping the
# prerelease `-` to `~` puts a prerelease before its release (1.0.0~rc.1 <
# 1.0.0); GNU `sort -V` would put 1.0.0 before 1.0.0-beta.1. Numeric
# dot-separated identifiers then compare as SemVer does (beta.9 < beta.10 <
# rc.1); mixed forms such as `beta1` vs `beta.1` follow dpkg's rules instead.
deb_version() { sed 's/^v//; s/-/~/' <<<"$1"; }

# 0/1 are dpkg's verdict; anything else is an error (e.g. a version it cannot
# parse) and must not read as "not lower" — callers would promote blindly.
rc=0
dpkg --compare-versions "$(deb_version "$1")" lt "$(deb_version "$2")" || rc=$?
case "$rc" in
  0 | 1) exit "$rc" ;;
  *) exit 2 ;;
esac
