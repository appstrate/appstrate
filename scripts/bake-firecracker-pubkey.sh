#!/usr/bin/env bash
# Bake the Firecracker manifest-signing public key into runner/artifacts.ts.
#
# Replaces the `__FIRECRACKER_ARTIFACTS_ED25519_PUBKEY__` placeholder with the
# real Ed25519 public key derived from FIRECRACKER_MANIFEST_SIGNING_KEY, BEFORE
# the image build / daemon compile consumes runner/artifacts.ts. Called from
# both the `build-and-push` (appstrate image ships apps/api source) and
# `build-runner-daemon` (compiles the key into the daemon binary) jobs in
# .github/workflows/release.yml — the single source of this logic so the two
# call sites can never drift.
#
# Fail-closed (mirrors the minisign guard in sign-cli): a release where some
# builds pin the real key and others still carry the placeholder (mixed
# signed/unsigned) is worse than a failed release — an unreplaced placeholder
# makes the daemon refuse to boot (FatalArtifactsError "signing key is not
# provisioned"). Uses the zero-dep signing script (node:crypto only).
#
# Runs from the repo root; paths below are relative to it.
set -euo pipefail

if [ -z "${FIRECRACKER_MANIFEST_SIGNING_KEY:-}" ]; then
  echo "::error::FIRECRACKER_MANIFEST_SIGNING_KEY secret must be set (base64 raw 32-byte Ed25519 seed)."
  echo "::error::Generate a keypair with: bun scripts/sign-firecracker-manifest.ts --generate"
  exit 1
fi

PUBKEY=$(bun scripts/sign-firecracker-manifest.ts --pubkey)
FILE=apps/api/src/modules/firecracker/runner/artifacts.ts
PLACEHOLDER="__FIRECRACKER_ARTIFACTS_ED25519_PUBKEY__"

# Drift guard: if the pinned-key constant moved/renamed, fail loudly instead of
# silently shipping a build that fails closed at boot.
if ! grep -q "\"$PLACEHOLDER\"" "$FILE"; then
  echo "::error::Placeholder $PLACEHOLDER not found in $FILE — the ARTIFACTS_SIGNING_PUBKEY constant moved or was renamed. Update scripts/bake-firecracker-pubkey.sh."
  exit 1
fi

sed -i "s|$PLACEHOLDER|$PUBKEY|g" "$FILE"

if grep -q "$PLACEHOLDER" "$FILE"; then
  echo "::error::Placeholder $PLACEHOLDER was not fully replaced in $FILE"
  exit 1
fi

echo "Baked Firecracker artifacts signing pubkey: $PUBKEY"
