#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Appstrate CLI bootstrap — thin downloader for `get.appstrate.dev`.
#
# Single responsibility: detect OS + arch, download the matching
# `appstrate` CLI binary from the GitHub Release whose tag is pinned
# by `publish-installer.yml` at publish time (or `latest` if this
# script is being run from a raw source copy), drop it on PATH, and
# exec `appstrate install` to hand control to the CLI itself.
#
# No install logic lives here — tier selection, secrets generation,
# compose rendering, healthchecks, and upgrades are all owned by the
# CLI binary. This script should never need to grow beyond ~30 lines.
#
# Usage:
#   curl -fsSL https://get.appstrate.dev | bash
#   curl -fsSL https://get.appstrate.dev | bash -s -- --tier 3
#
# Env overrides:
#   APPSTRATE_VERSION   Pin a release tag (default: the tag the
#                       publish pipeline stamped into this script).
#   APPSTRATE_BIN_DIR   Install location (default: /usr/local/bin).

set -euo pipefail

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

case "$OS" in
  darwin | linux) ;;
  *)
    echo "Unsupported OS: $OS. Windows users: \`bunx @appstrate/cli install\`." >&2
    exit 1
    ;;
esac

# Default version pinned by `publish-installer.yml` at publish time —
# rewriting `__APPSTRATE_VERSION__` so `curl get.appstrate.dev | bash`
# downloads the binary matching the release that published this script.
# Users can override via APPSTRATE_VERSION env var (e.g. to pin an older
# release). When the placeholder is still present (local dev / unrendered
# copy), fall back to `latest` so the script stays runnable out of tree.
_DEFAULT_VERSION="__APPSTRATE_VERSION__"
if [[ "$_DEFAULT_VERSION" == __* ]]; then _DEFAULT_VERSION="latest"; fi
VERSION="${APPSTRATE_VERSION:-$_DEFAULT_VERSION}"
BIN_DIR="${APPSTRATE_BIN_DIR:-/usr/local/bin}"
DEST="${BIN_DIR}/appstrate"

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/appstrate/appstrate-oss/releases/latest/download/appstrate-${OS}-${ARCH}"
else
  URL="https://github.com/appstrate/appstrate-oss/releases/download/${VERSION}/appstrate-${OS}-${ARCH}"
fi

# `sudo` only if the destination isn't user-writable — skips a
# pointless auth prompt when /usr/local/bin is already owned by the
# user (common on macOS Homebrew setups under /opt/homebrew + symlinked
# /usr/local/bin).
SUDO=""
if [ ! -w "$BIN_DIR" ]; then
  SUDO="sudo"
fi

echo "Downloading Appstrate CLI ($OS/$ARCH, $VERSION)..."
$SUDO curl -fsSL "$URL" -o "$DEST"
$SUDO chmod +x "$DEST"

echo "Launching \`appstrate install\`..."
exec appstrate install "$@"
