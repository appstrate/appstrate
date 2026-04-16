#!/usr/bin/env bash
#
# Appstrate installer — verified install wrapper
#
#   curl -fsSL https://get.appstrate.dev/verify.sh | bash
#
# Downloads install.sh + install.sh.minisig, verifies the minisign signature
# against the Appstrate public key, then executes the installer.
#
# Requires: curl, minisign (https://jedisct1.github.io/minisign/)

set -euo pipefail
umask 077

# ─── Appstrate public key ────────────────────────────────────────────────────
# This must match the private key held by the release workflow.
# Rotation: publish the new key under scripts/appstrate.pub, update this value,
# bump the installer, and document the change in the release notes.
#
# Placeholder — replaced once the signing keypair is generated and stored in
# GitHub Actions secrets (see docs: examples/self-hosting/README.md#verifying).
APPSTRATE_PUBKEY="__APPSTRATE_MINISIGN_PUBKEY__"

BASE_URL="${APPSTRATE_BASE_URL:-https://get.appstrate.dev}"

err() { printf '\033[0;31m✗\033[0m %s\n' "$*" >&2; }
log() { printf '\033[0;36m→\033[0m %s\n' "$*"; }
ok() { printf '\033[0;32m✓\033[0m %s\n' "$*"; }

if [[ "$APPSTRATE_PUBKEY" == __* ]]; then
  err "verify.sh has not been provisioned with a public key yet."
  err "  → The Appstrate signing keypair has not been generated."
  err "  → Use the unsigned installer for now: curl -fsSL ${BASE_URL} | bash"
  err "  → Track progress: https://github.com/appstrate/appstrate/issues"
  exit 1
fi

if ! command -v minisign >/dev/null 2>&1; then
  err "minisign is required for signature verification."
  err "  → macOS:  brew install minisign"
  err "  → Debian: sudo apt install minisign"
  err "  → Other:  https://jedisct1.github.io/minisign/"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  err "curl is required"
  exit 1
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

log "Downloading installer + signature from ${BASE_URL}"
curl -fsSLo "$TMPDIR/install.sh" "${BASE_URL}/install.sh"
curl -fsSLo "$TMPDIR/install.sh.minisig" "${BASE_URL}/install.sh.minisig"

log "Verifying signature"
if ! minisign -Vm "$TMPDIR/install.sh" -P "$APPSTRATE_PUBKEY" >/dev/null; then
  err "Signature verification FAILED"
  err "  → The installer may have been tampered with in transit."
  err "  → Do NOT execute it. Report: https://github.com/appstrate/appstrate/issues"
  exit 1
fi
ok "Signature valid"

log "Running installer"
exec bash "$TMPDIR/install.sh" "$@"
