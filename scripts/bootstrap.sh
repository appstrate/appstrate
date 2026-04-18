#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Appstrate CLI bootstrap — thin downloader for `get.appstrate.dev`.
#
# Replaces the monolithic `scripts/install.sh` once per-target CLI
# binaries are published to GitHub Releases (Phase 3+). Single
# responsibility: detect OS + arch, download the matching `appstrate`
# binary, drop it on PATH, and exec `appstrate install` to hand
# control to the CLI itself.
#
# No install logic lives here — tier selection, secrets, compose
# rendering, healthchecks, upgrades are all owned by the CLI binary.
# This script should never need to grow beyond ~30 lines.
#
# Usage:
#   curl -fsSL https://get.appstrate.dev | bash
#   curl -fsSL https://get.appstrate.dev | bash -s -- --tier 3
#
# Env overrides:
#   APPSTRATE_VERSION   Pin a release tag (default: latest).
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

VERSION="${APPSTRATE_VERSION:-latest}"
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
