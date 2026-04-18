#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Appstrate CLI bootstrap — thin downloader for `get.appstrate.dev`.
#
# Single responsibility: detect OS + arch, download the matching
# `appstrate` CLI binary from the GitHub Release whose tag is pinned
# by `publish-installer.yml` at publish time (or `latest` if this
# script is being run from a raw source copy), VERIFY its integrity
# + provenance against a minisign-signed SHA-256 manifest, drop it on
# PATH, and exec `appstrate install` to hand control to the CLI itself.
#
# No install logic lives here — tier selection, secrets generation,
# compose rendering, healthchecks, and upgrades are all owned by the
# CLI binary. This script stays small on purpose.
#
# Trust chain:
#   1. `scripts/verify.sh` (served at `get.appstrate.dev/verify.sh`)
#      verifies the signature on THIS script before executing it. That
#      is the opt-in wrapper for users who refuse trust-on-TLS at the
#      `get.appstrate.dev | bash` step.
#   2. THIS script then downloads + verifies the signature on the
#      per-release `checksums.txt` against the baked-in public key,
#      then verifies the SHA-256 of the downloaded binary matches.
#      The CLI binary is never exec'd until both checks pass.
#
# Usage:
#   curl -fsSL https://get.appstrate.dev | bash
#   curl -fsSL https://get.appstrate.dev | bash -s -- --tier 3
#
# Env overrides:
#   APPSTRATE_VERSION        Pin a release tag (default: pinned or "latest").
#   APPSTRATE_BIN_DIR        Install location (default: /usr/local/bin).
#   APPSTRATE_SKIP_VERIFY=1  Skip signature + checksum verification (CI
#                            debug only — do NOT set on user machines).

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
    # Windows is deliberately not a v1 target — see ADR-006 § Deliverable.
    # The recommended path on Windows is WSL2 (which reuses the linux-x64
    # binary); `bunx @appstrate/cli install` is the Bun-native escape
    # hatch for users who have Bun but no WSL2. We fail loud here instead
    # of hinting at a flow this script doesn't handle.
    echo "Unsupported OS: $OS." >&2
    echo "On Windows, run this inside WSL2 (recommended), or install natively via: bunx @appstrate/cli install" >&2
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
ASSET="appstrate-${OS}-${ARCH}"

# Appstrate minisign public key — baked into the distributed
# bootstrap.sh so a freshly-bootstrapped machine can verify without a
# second round-trip. Matches `scripts/appstrate.pub` in the repo; the
# release workflow signs `checksums.txt` with the matching private key.
# Rotation SOP: docs/adr/ADR-006-cli-device-flow-monorepo.md.
APPSTRATE_MINISIGN_PUBKEY="RWT6xCZCCP/yHolAgDuDqBssxUflw7gInlZlaXEfQ4cFi5XN0KCtKr0e"

if [ "$VERSION" = "latest" ]; then
  URL_BASE="https://github.com/appstrate/appstrate/releases/latest/download"
else
  URL_BASE="https://github.com/appstrate/appstrate/releases/download/${VERSION}"
fi
URL="${URL_BASE}/${ASSET}"
CHECKSUMS_URL="${URL_BASE}/checksums.txt"
CHECKSUMS_SIG_URL="${URL_BASE}/checksums.txt.minisig"

# ─── Helpers ────────────────────────────────────────────────────────────────

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

warn() { printf '\033[0;33m⚠\033[0m  %s\n' "$*" >&2; }
log() { printf '\033[0;36m→\033[0m  %s\n' "$*"; }
err() { printf '\033[0;31m✗\033[0m  %s\n' "$*" >&2; }

have_sha256sum() { command -v sha256sum >/dev/null 2>&1; }
have_shasum() { command -v shasum >/dev/null 2>&1; }
have_minisign() { command -v minisign >/dev/null 2>&1; }

# ─── Download + verify ──────────────────────────────────────────────────────

log "Downloading Appstrate CLI ($OS/$ARCH, $VERSION)"
curl -fsSL "$URL" -o "$TMPDIR/$ASSET"

if [ "${APPSTRATE_SKIP_VERIFY:-0}" = "1" ]; then
  warn "APPSTRATE_SKIP_VERIFY=1 — integrity + provenance checks skipped."
  warn "Only use this in controlled CI debug runs. Do NOT set on user machines."
  # Deliberate 5-second pause so a sysadmin auditing a paste-bin install
  # script has a visible window to Ctrl-C before execution. A silent warn
  # on stderr is trivially lost in terminal noise; `rustup-init` uses the
  # same pattern. Non-interactive contexts (no TTY) still pause — the
  # whole point is to slow down unattended piping into `| bash`.
  warn "Proceeding in 5 seconds. Press Ctrl-C to abort."
  sleep 5
else
  # Verification is gated on minisign availability. Without it we can't
  # cryptographically tie the binary to the Appstrate release key; just
  # matching a checksum file downloaded over the same TLS channel as the
  # binary is security theatre (an on-path attacker can rewrite both).
  # Fail closed — the one-line install command the user just executed
  # took < 5s; installing minisign via the OS package manager costs
  # roughly the same.
  if ! have_minisign; then
    err "minisign is required to verify the Appstrate CLI download."
    err "  → macOS:   brew install minisign"
    err "  → Debian:  sudo apt install minisign"
    err "  → Alpine:  apk add minisign"
    err "  → Other:   https://jedisct1.github.io/minisign/"
    err ""
    err "To override (NOT recommended, only for CI debug), re-run with"
    err "  APPSTRATE_SKIP_VERIFY=1 curl -fsSL https://get.appstrate.dev | bash"
    exit 1
  fi

  log "Fetching release checksums + signature"
  curl -fsSL "$CHECKSUMS_URL" -o "$TMPDIR/checksums.txt"
  curl -fsSL "$CHECKSUMS_SIG_URL" -o "$TMPDIR/checksums.txt.minisig"

  log "Verifying signature against Appstrate release key"
  if ! minisign -Vm "$TMPDIR/checksums.txt" -P "$APPSTRATE_MINISIGN_PUBKEY" >/dev/null; then
    err "Signature verification FAILED."
    err "  → The checksums manifest was NOT signed by the Appstrate key."
    err "  → Your download is possibly tampered — do NOT execute."
    err "  → Report: https://github.com/appstrate/appstrate/issues"
    exit 1
  fi

  log "Verifying binary integrity (SHA-256)"
  # Prefer the GNU tool when available; fall back to BSD `shasum -c`
  # (default on macOS without coreutils). Both speak the same `<hash>
  # <filename>` line format so `checksums.txt` is compatible.
  (
    cd "$TMPDIR"
    # Only the line for our asset matters — filtering keeps the tool
    # from failing on missing sibling binaries we didn't download.
    grep " ${ASSET}\$" checksums.txt >checksums.local.txt
    if have_sha256sum; then
      sha256sum -c --quiet checksums.local.txt
    elif have_shasum; then
      shasum -a 256 -c --quiet checksums.local.txt
    else
      err "Neither sha256sum nor shasum is available on this system."
      exit 1
    fi
  ) || {
    err "SHA-256 mismatch — the downloaded binary does NOT match the signed manifest."
    err "  → This strongly suggests tampering in transit. Do NOT execute."
    err "  → Report: https://github.com/appstrate/appstrate/issues"
    exit 1
  }
  log "Integrity + provenance verified"
fi

# ─── Install ────────────────────────────────────────────────────────────────

# `sudo` only if the destination isn't user-writable — skips a pointless
# auth prompt when /usr/local/bin is already owned by the user (common
# on macOS Homebrew setups under /opt/homebrew + symlinked /usr/local/bin).
SUDO=""
if [ ! -w "$BIN_DIR" ]; then
  SUDO="sudo"
fi

log "Installing to $DEST"
$SUDO install -m 0755 "$TMPDIR/$ASSET" "$DEST"

log "Launching \`appstrate install\`"
exec appstrate install "$@"
