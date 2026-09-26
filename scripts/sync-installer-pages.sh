#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# sync-installer-pages.sh VERSION OUT_DIR PAGES_DIR — publish the rendered,
# signed installers of VERSION from OUT_DIR into the installer-pages checkout
# PAGES_DIR, and move the "latest" channel only forward:
#
#   - PAGES_DIR/VERSION/ is written once, never overwritten: re-dispatching an
#     already-published tag keeps its originally published (and attested) bytes.
#     That is how the first manifest is seeded and the channel re-pointed.
#   - VERSION is promoted only when it is not older than the current manifest's
#     tag (scripts/semver-lt.sh); an unreadable manifest aborts before any write.
#     Promotion copies the root pointers (install.sh, runner, their .sha256 and
#     .minisig, index.html) from PAGES_DIR/VERSION/, so channel and root always
#     name the same immutable bytes, then verify.sh, appstrate.pub and
#     channels/latest.json(.minisig) from OUT_DIR. An older tag (a hotfix on a
#     previous line) only adds its versioned dir.
#
# Rollback: on installer-pages, restore only the pointers from the previous
# commit, then commit and push:
#   git checkout <prev> -- channels index.html install.sh install.sh.sha256 \
#     install.sh.minisig runner runner.sha256 runner.minisig verify.sh appstrate.pub
# A path <prev> predates (e.g. channels, rolling back the first manifest) is
# `git rm -r`ed instead: one missing pathspec aborts the whole checkout.
# Never `git revert` the `publish: <tag>` commit: it also created <tag>/, and
# deleting it 404s pinned installs (a re-dispatch would re-render other bytes).
# Later publishes are then compared against the restored manifest.
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

# Decide first: a malformed current manifest must leave the branch as it is,
# never fall through to promotion. semver-lt: 0 = older, 1 = not older, else error.
PROMOTE=true
CURRENT=""
if [ -f "$PAGES/channels/latest.json" ]; then
  if ! CURRENT=$(jq -r .tag "$PAGES/channels/latest.json"); then
    echo "::error::channels/latest.json is not valid JSON — fix the installer-pages branch by hand."
    exit 1
  fi
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

if [ -e "$PAGES/$VERSION" ]; then
  echo "::notice::${VERSION} is already published — its versioned installers are kept as published."
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

for f in install.sh install.sh.sha256 install.sh.minisig runner runner.sha256 runner.minisig; do
  cp "$PAGES/$VERSION/$f" "$PAGES/$f"
done
# GitHub Pages serves index.html at /, so `curl -fsSL https://get.appstrate.dev
# | bash` gets the installer itself (same pattern as get.docker.com).
cp "$PAGES/$VERSION/install.sh" "$PAGES/index.html"
cp "$OUT/verify.sh" "$OUT/appstrate.pub" "$PAGES/"
mkdir -p "$PAGES/channels"
cp "$OUT/channels/latest.json" "$OUT/channels/latest.json.minisig" "$PAGES/channels/"
summary "Channel latest promoted to ${VERSION} (was: ${CURRENT:-none})."
