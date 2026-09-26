#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# sync-installer-pages.sh VERSION OUT_DIR PAGES_DIR — copy the rendered, signed
# installers of VERSION from OUT_DIR into the installer-pages checkout
# PAGES_DIR, and move the "latest" channel only forward:
#
#   - PAGES_DIR/VERSION/ is written once, never overwritten. A tag that is
#     already published leaves every installer file untouched (versioned AND
#     root) and only (re)publishes channels/latest.json — how the first
#     manifest is seeded, and how the channel is re-pointed forward.
#   - The root pointers (install.sh, runner, index.html) and the manifest are
#     promoted only when VERSION is not older than the current manifest's tag
#     (scripts/semver-lt.sh). An unreadable current tag aborts before any write.
#
# Used by publish-installer.yml; fixture-tested in test-install.yml. Needs jq
# and dpkg (Debian/Ubuntu runners).

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <version> <out-dir> <pages-dir>" >&2
  exit 2
fi
VERSION=$1 OUT=$2 PAGES=$3
SEMVER_LT="$(dirname "$0")/semver-lt.sh"

# Stdout everywhere, plus the job summary on GitHub Actions.
summary() {
  echo "$*"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$*" >>"$GITHUB_STEP_SUMMARY"; fi
}

# Decide first: a malformed current tag must leave the branch as it is, never
# fall through to promotion. semver-lt: 0 = older, 1 = not older, else error.
PROMOTE=true
CURRENT=""
if [ -f "$PAGES/channels/latest.json" ]; then
  CURRENT=$(jq -r .tag "$PAGES/channels/latest.json")
  rc=0
  "$SEMVER_LT" "$VERSION" "$CURRENT" || rc=$?
  case "$rc" in
    0) PROMOTE=false ;;
    1) ;;
    *)
      echo "::error::Cannot compare ${VERSION} with channels/latest.json tag '${CURRENT}' — fix the installer-pages branch by hand."
      exit 1
      ;;
  esac
fi

PUBLISHED=false
if [ -e "$PAGES/$VERSION" ]; then
  PUBLISHED=true
  echo "::notice::${VERSION} is already published — installer files left untouched, channel manifest only."
else
  mkdir -p "$PAGES/$VERSION"
  for f in install.sh install.sh.sha256 runner runner.sha256; do
    cp "$OUT/$VERSION/$f" "$PAGES/$VERSION/$f"
  done
  # One signature per installer: both rendered copies are byte-identical.
  cp "$OUT/install.sh.minisig" "$OUT/runner.minisig" "$PAGES/$VERSION/"
fi

if [ "$PROMOTE" = false ]; then
  echo "::warning::Channel latest stays at ${CURRENT}: ${VERSION} is older."
  summary "Channel latest NOT promoted: ${VERSION} < ${CURRENT}."
  exit 0
fi

if [ "$PUBLISHED" = false ]; then
  for f in install.sh install.sh.sha256 install.sh.minisig runner runner.sha256 runner.minisig; do
    cp "$OUT/$f" "$PAGES/$f"
  done
  # GitHub Pages serves index.html at /, so `curl -fsSL https://get.appstrate.dev
  # | bash` gets the installer itself (same pattern as get.docker.com).
  cp "$OUT/install.sh" "$PAGES/index.html"
fi
mkdir -p "$PAGES/channels"
cp "$OUT/channels/latest.json" "$OUT/channels/latest.json.minisig" "$PAGES/channels/"
summary "Channel latest promoted to ${VERSION} (was: ${CURRENT:-none})."
