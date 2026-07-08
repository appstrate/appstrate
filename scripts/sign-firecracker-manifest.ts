// SPDX-License-Identifier: Apache-2.0

/**
 * Sign the Firecracker guest-artifacts manifest with the release Ed25519 key,
 * and derive the public key that gets baked into shipped builds.
 *
 * The `appstrate-runner` daemon treats `firecracker-artifacts-manifest.json`
 * as the ROOT OF TRUST for the guest kernel/rootfs hashes, so the manifest
 * itself must be authenticated: the resolver
 * (apps/api/src/modules/firecracker/runner/artifacts.ts) downloads the
 * detached `firecracker-artifacts-manifest.json.sig` release asset and
 * verifies it against a source-pinned public key before trusting any hash
 * inside the manifest. This script is the release-side counterpart — it
 * produces the signature in the EXACT format the resolver verifies:
 *
 *   - key:       Ed25519. Secret = base64 raw 32-byte seed in the
 *                `FIRECRACKER_MANIFEST_SIGNING_KEY` env var (GitHub Actions
 *                secret of the same name).
 *   - signature: base64 raw 64-byte Ed25519 signature over the exact
 *                manifest bytes, written as a single line to `<path>.sig`.
 *   - pubkey:    base64 raw 32-byte Ed25519 public key — the value sed-baked
 *                over the `__FIRECRACKER_ARTIFACTS_ED25519_PUBKEY__`
 *                placeholder (ARTIFACTS_SIGNING_PUBKEY) at release time.
 *
 * Usage (CI — .github/workflows/release.yml):
 *   FIRECRACKER_MANIFEST_SIGNING_KEY=<base64 seed> \
 *     bun scripts/sign-firecracker-manifest.ts --pubkey
 *       → prints the base64 raw public key on stdout (nothing else)
 *   FIRECRACKER_MANIFEST_SIGNING_KEY=<base64 seed> \
 *     bun scripts/sign-firecracker-manifest.ts firecracker-artifacts-manifest.json
 *       → writes firecracker-artifacts-manifest.json.sig and self-verifies
 *
 * Keypair generation (operator, once — store the seed as the GitHub secret):
 *   bun scripts/sign-firecracker-manifest.ts --generate
 *       → prints a fresh seed + its public key (never touches the network)
 *
 * Zero dependencies (node:crypto + node:fs only) so it runs on a bare
 * checkout without `bun install`.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";

const SECRET_ENV = "FIRECRACKER_MANIFEST_SIGNING_KEY";

/**
 * PKCS#8 DER prefix for an Ed25519 private key (RFC 8410). Appending the raw
 * 32-byte seed yields a complete DER document node:crypto can import — this
 * is what lets the GitHub secret be a plain base64 seed instead of PEM.
 */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function fail(message: string): never {
  console.error(`sign-firecracker-manifest: ${message}`);
  process.exit(1);
}

function importPrivateKey(): KeyObject {
  const secret = process.env[SECRET_ENV]?.trim();
  if (!secret) {
    fail(`${SECRET_ENV} is not set — expected a base64 raw 32-byte Ed25519 seed.`);
  }
  const seed = Buffer.from(secret, "base64");
  if (seed.length !== 32) {
    fail(
      `${SECRET_ENV} must decode to exactly 32 bytes (got ${seed.length}) — ` +
        `expected a base64 raw Ed25519 seed.`,
    );
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** Base64 raw 32-byte public key — the format ARTIFACTS_SIGNING_PUBKEY pins. */
function publicKeyBase64(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (typeof jwk.x !== "string") {
    fail("could not export the Ed25519 public key (missing JWK x member).");
  }
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

function generateKeypair(): void {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = pkcs8.subarray(PKCS8_ED25519_PREFIX.length).toString("base64");
  console.log(`${SECRET_ENV} (GitHub Actions secret — keep private):`);
  console.log(`  ${seed}`);
  console.log("Public key (safe to publish — bake into ARTIFACTS_SIGNING_PUBKEY):");
  console.log(`  ${publicKeyBase64(privateKey)}`);
}

function signManifest(manifestPath: string): void {
  const privateKey = importPrivateKey();
  const manifestBytes = readFileSync(manifestPath);
  // Ed25519 is a pure signature scheme: algorithm must be null, and the
  // output is always the raw 64-byte signature the resolver expects.
  const signature = sign(null, manifestBytes, privateKey);
  if (signature.length !== 64) {
    fail(`produced a ${signature.length}-byte signature — expected raw 64-byte Ed25519.`);
  }
  // Self-verify against the DERIVED public key before publishing — exactly
  // what the daemon will do, so a key/seed mixup fails the release here
  // rather than bricking every runner boot in the field.
  const pubkey = publicKeyBase64(privateKey);
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pubkey, "base64").toString("base64url") },
    format: "jwk",
  });
  if (!verify(null, manifestBytes, publicKey, signature)) {
    fail("self-verification failed — the produced signature does not verify (corrupt key?).");
  }
  const sigPath = `${manifestPath}.sig`;
  writeFileSync(sigPath, `${signature.toString("base64")}\n`);
  console.error(`Signed ${manifestPath} → ${sigPath} (Ed25519 pubkey ${pubkey})`);
}

const arg = process.argv[2];
if (arg === "--generate") {
  generateKeypair();
} else if (arg === "--pubkey") {
  process.stdout.write(publicKeyBase64(importPrivateKey()));
} else if (arg) {
  signManifest(arg);
} else {
  fail("usage: sign-firecracker-manifest.ts <manifest-path> | --pubkey | --generate");
}
