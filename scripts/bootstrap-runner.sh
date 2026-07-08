#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Appstrate RUNNER bootstrap — thin downloader for `get.appstrate.dev/runner`.
#
# Single responsibility: on a KVM host, download + verify the `appstrate`
# CLI binary (same signed trust chain as `get.appstrate.dev`), drop it on
# PATH, and hand off to `appstrate runner install`. The CLI then downloads
# the compiled daemon binary + firecracker, writes a hardened systemd unit,
# and starts the daemon. No daemon logic lives here.
#
# Usage:
#   curl -fsSL https://get.appstrate.dev/runner | bash -s -- \
#     --platform-url http://<PLATFORM_IPV4>:3000 --token <TOKEN>
#
#   Co-located install (platform container on the same host) — bind a Unix
#   domain socket instead of a TCP port (platform then uses
#   FIRECRACKER_RUNNER_URL=unix:///run/appstrate-runner/runner.sock):
#   curl -fsSL https://get.appstrate.dev/runner | bash -s -- \
#     --platform-url http://<PLATFORM_IPV4>:3000 --token <TOKEN> \
#     --socket /run/appstrate-runner/runner.sock
#
# Env overrides (mirror scripts/bootstrap.sh):
#   APPSTRATE_VERSION        Pin a release tag (default: pinned or "latest").
#   APPSTRATE_BIN_DIR        CLI install location (default: /usr/local/bin —
#                            system-wide, since the runner host is root-managed).
#   APPSTRATE_SKIP_VERIFY=1  Skip signature/checksum verification (CI debug,
#                            requires CI=true — do NOT set on real hosts).

set -euo pipefail

_appstrate_runner_bootstrap() {
  # ─── The runner is a Linux/KVM daemon — refuse anything else early ────────
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  if [ "$OS" != "linux" ]; then
    echo "The Appstrate runner daemon requires a Linux KVM host (detected: $OS)." >&2
    echo "Run this on your KVM host. On macOS, develop inside the Lima VM instead." >&2
    exit 1
  fi

  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *)
      echo "Unsupported architecture: $ARCH" >&2
      exit 1
      ;;
  esac

  # ─── Privilege model ──────────────────────────────────────────────────────
  # Download + verification run UNPRIVILEGED (as the invoking operator) so root
  # never executes an unverified downloaded artifact. Only the final steps that
  # genuinely need it — writing the verified binary onto PATH and handing off to
  # `appstrate runner install` (which writes /etc + systemd) — are elevated via
  # sudo. This keeps the `curl … | bash` trust chain minisign-anchored: the
  # bytes root runs are the bytes we already verified below. We therefore do NOT
  # re-exec the whole (piped, unverified) shell function as root.
  SUDO=""
  if [ "$(id -u)" != "0" ]; then
    if command -v sudo >/dev/null 2>&1; then
      SUDO="sudo -E"
    else
      echo "The runner installer must run as root. Re-run with sudo." >&2
      exit 1
    fi
  fi

  _DEFAULT_VERSION="__APPSTRATE_VERSION__"
  if [[ "$_DEFAULT_VERSION" == __* ]]; then _DEFAULT_VERSION="latest"; fi
  VERSION="${APPSTRATE_VERSION:-$_DEFAULT_VERSION}"
  BIN_DIR="${APPSTRATE_BIN_DIR:-/usr/local/bin}"
  DEST="${BIN_DIR}/appstrate"
  ASSET="appstrate-${OS}-${ARCH}"

  # Same key as scripts/bootstrap.sh — signs every release's checksums.txt.
  APPSTRATE_MINISIGN_PUBKEY="RWT6xCZCCP/yHolAgDuDqBssxUflw7gInlZlaXEfQ4cFi5XN0KCtKr0e"

  if [ "$VERSION" = "latest" ]; then
    URL_BASE="https://github.com/appstrate/appstrate/releases/latest/download"
  else
    URL_BASE="https://github.com/appstrate/appstrate/releases/download/${VERSION}"
  fi

  TMPDIR=$(mktemp -d)
  trap 'rm -rf "$TMPDIR"' EXIT
  log() { printf '\033[0;36m→\033[0m  %s\n' "$*"; }
  err() { printf '\033[0;31m✗\033[0m  %s\n' "$*" >&2; }

  log "Downloading Appstrate CLI ($OS/$ARCH, $VERSION)"
  curl -fsSL "${URL_BASE}/${ASSET}" -o "$TMPDIR/$ASSET"

  if [ "${APPSTRATE_SKIP_VERIFY:-0}" = "1" ]; then
    if [ "${CI:-}" != "true" ]; then
      err "APPSTRATE_SKIP_VERIFY=1 requires CI=true — refusing to skip verification on a real host."
      exit 1
    fi
    err "APPSTRATE_SKIP_VERIFY=1 — integrity/provenance checks skipped (CI debug only)."
  else
    if ! command -v minisign >/dev/null 2>&1; then
      err "minisign is required to verify the download:"
      err "  → Debian:  apt install minisign    → Alpine: apk add minisign"
      err "  → RHEL:    dnf install minisign     → other:  https://jedisct1.github.io/minisign/"
      exit 1
    fi
    log "Verifying signature + checksum"
    curl -fsSL "${URL_BASE}/checksums.txt" -o "$TMPDIR/checksums.txt"
    curl -fsSL "${URL_BASE}/checksums.txt.minisig" -o "$TMPDIR/checksums.txt.minisig"
    if ! minisign -Vm "$TMPDIR/checksums.txt" -P "$APPSTRATE_MINISIGN_PUBKEY" >/dev/null; then
      err "Signature verification FAILED — do NOT execute. Report: https://github.com/appstrate/appstrate/issues"
      exit 1
    fi
    (
      cd "$TMPDIR"
      grep " ${ASSET}\$" checksums.txt > checksums.local.txt || true
      if [ ! -s checksums.local.txt ] || [ "$(wc -l < checksums.local.txt)" -ne 1 ]; then
        err "Asset ${ASSET} not uniquely listed in the signed manifest — refusing to install."
        exit 1
      fi
      if command -v sha256sum >/dev/null 2>&1; then
        sha256sum -c checksums.local.txt >/dev/null
      else
        shasum -a 256 -c checksums.local.txt >/dev/null
      fi
    ) || {
      err "SHA-256 mismatch — the binary does NOT match the signed manifest. Do NOT execute."
      exit 1
    }
    log "Integrity + provenance verified"
  fi

  # Only now do we elevate — to install the already-verified binary and to run
  # the CLI that writes /etc + systemd. $SUDO is empty when already root.
  $SUDO mkdir -p "$BIN_DIR"
  $SUDO install -m 0755 "$TMPDIR/$ASSET" "$DEST"
  log "Installed CLI → $DEST"

  # Hand off to the CLI. Exec by absolute path (never a shadowed `appstrate`
  # earlier on PATH) so the verified binary is the one that runs.
  log "Launching \`appstrate runner install\`"
  exec $SUDO "$DEST" runner install "$@"
}

_appstrate_runner_bootstrap "$@"
