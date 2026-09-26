#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# semver-lt.sh A B — exit 0 iff release tag A < tag B by SemVer precedence,
# 1 otherwise, 2 on a usage error or a malformed tag. Tags are vX.Y.Z[-pre].
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
# prerelease `-` to `~` yields SemVer precedence (1.0.0~rc.1 < 1.0.0); GNU
# `sort -V` would put 1.0.0 before 1.0.0-beta.1.
deb_version() { sed 's/^v//; s/-/~/' <<<"$1"; }

if dpkg --compare-versions "$(deb_version "$1")" lt "$(deb_version "$2")"; then
  exit 0
fi
exit 1
