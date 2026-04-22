// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS bundle signing — Ed25519 detached signatures per ADR-009
 * Phase v1. Sigstore keyless (Phase v2) is stubbed via
 * {@link verifySigstoreSignature} so Phase 11 can swap the
 * implementation without a breaking API change.
 *
 * Signature document layout (written as `signature.sig` at the bundle
 * root, alongside `manifest.json`):
 *
 * ```json
 * {
 *   "alg": "ed25519",
 *   "keyId": "publisher-abc123",
 *   "signature": "<base64 Ed25519 over bundle bytes>",
 *   "chain": [
 *     {
 *       "keyId": "publisher-abc123",
 *       "publicKey": "<base64 raw 32 bytes>",
 *       "signature": "<base64 Ed25519 over publicKey bytes>",
 *       "parentKeyId": "appstrate-root-2026"
 *     }
 *   ]
 * }
 * ```
 *
 * Verification pins trust by `keyId` + raw public key. Bundles signed
 * by a key that is directly in the trust root verify without a chain.
 * Bundles signed by a publisher key must present a `chain` that
 * terminates in a root-trusted ancestor; each link is the parent's
 * Ed25519 signature over the child's raw public-key bytes.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import type { Bundle } from "./types.ts";

export interface BundleSignature {
  alg: "ed25519";
  keyId: string;
  /** Base64 Ed25519 signature over the raw bundle bytes. */
  signature: string;
  /** Optional trust chain. Absent for direct-trust bundles. */
  chain?: readonly TrustChainEntry[];
}

export interface TrustChainEntry {
  keyId: string;
  /** Base64 raw 32-byte Ed25519 public key. */
  publicKey: string;
  /** Base64 Ed25519 signature (by parent) over this entry's raw public-key bytes. */
  signature: string;
  /** keyId of the parent that signed `publicKey`. Absent for the chain's topmost entry. */
  parentKeyId?: string;
}

export interface TrustedKey {
  keyId: string;
  /** Base64 raw 32-byte Ed25519 public key. */
  publicKey: string;
  /** Optional human-readable note — ignored by verification. */
  comment?: string;
}

export interface TrustRoot {
  keys: readonly TrustedKey[];
}

export interface KeyPair {
  keyId: string;
  /** Base64 raw 32-byte Ed25519 public key. */
  publicKey: string;
  /** Base64 raw 32-byte Ed25519 private-key seed. */
  privateKey: string;
}

export interface SignBundleOptions {
  /** Base64 raw 32-byte Ed25519 private-key seed. */
  privateKey: string;
  /** Identifier used to look up this key in the trust root or chain. */
  keyId: string;
  /** Optional chain linking `keyId` up to a trust-root-known ancestor. */
  chain?: readonly TrustChainEntry[];
}

export interface SignChildKeyOptions {
  /** Identifier for the child key being signed. */
  childKeyId: string;
  /** Base64 raw 32-byte public key of the child. */
  childPublicKey: string;
  /** Base64 raw 32-byte Ed25519 seed of the parent signer. */
  parentPrivateKey: string;
  /** Identifier of the parent signer — recorded on the chain entry. */
  parentKeyId: string;
}

export type VerifySignatureFailureReason =
  | "signature_invalid"
  | "alg_unsupported"
  | "chain_untrusted"
  | "chain_invalid"
  | "chain_missing"
  | "malformed";

export type VerifySignatureResult =
  | { ok: true; keyId: string }
  | { ok: false; reason: VerifySignatureFailureReason; detail?: string };

/**
 * Generate a fresh Ed25519 key pair. `keyId` is a short deterministic
 * fingerprint (first 16 hex chars of sha256 over the raw public key) —
 * callers are free to override it when managing their own identifier
 * scheme (e.g. `appstrate-root-2026`).
 */
export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pubRaw = rawFromPublicKey(publicKey);
  const privRaw = rawFromPrivateKey(privateKey);
  return {
    keyId: keyIdFromPublicKey(pubRaw),
    publicKey: Buffer.from(pubRaw).toString("base64"),
    privateKey: Buffer.from(privRaw).toString("base64"),
  };
}

/**
 * Deterministic short identifier derived from a raw Ed25519 public key
 * (first 16 hex chars of sha256). Stable across runs; useful as a
 * defaulting keyId when the caller has no better name.
 */
export function keyIdFromPublicKey(publicKey: string | Uint8Array): string {
  const bytes =
    typeof publicKey === "string" ? Buffer.from(publicKey, "base64") : Buffer.from(publicKey);
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * Produce a detached signature document for the given bundle bytes.
 *
 * The caller is responsible for writing the returned JSON back into the
 * bundle as `signature.sig` (repackaging the ZIP) — the runtime keeps
 * signing and packaging concerns independent so the same primitive
 * can sign OCI artifacts, detached `.sig` files, or in-memory buffers.
 */
export function signBundle(bundleBytes: Uint8Array, opts: SignBundleOptions): BundleSignature {
  const privKey = importPrivateKey(opts.privateKey);
  const signature = nodeSign(null, bundleBytes, privKey);
  const doc: BundleSignature = {
    alg: "ed25519",
    keyId: opts.keyId,
    signature: signature.toString("base64"),
  };
  if (opts.chain && opts.chain.length > 0) {
    doc.chain = opts.chain;
  }
  return doc;
}

/**
 * Deterministic digest of a bundle's logical contents, suitable as
 * input to {@link signBundle} / {@link verifyBundleSignature}.
 *
 * ZIP container bytes are not stable (compression method, timestamps,
 * central-directory ordering all vary by tool) so signatures taken
 * over raw ZIP bytes break under legitimate re-packing. This helper
 * reduces the bundle to `JSON([ [sortedPath, "sha256-<b64>"], … ])`
 * — a plain-text canonical form that every conforming runner can
 * reproduce from the same file set.
 *
 * `signature.sig` is excluded by default so signing/verifying are
 * symmetrical (the signer computes this before writing the signature,
 * the verifier strips it from the loaded bundle).
 */
export function canonicalBundleDigest(
  files: Record<string, Uint8Array>,
  exclude: readonly string[] = ["signature.sig"],
): Uint8Array {
  const excludeSet = new Set(exclude);
  const entries: Array<[string, string]> = [];
  for (const [path, content] of Object.entries(files)) {
    if (excludeSet.has(path)) continue;
    const hash = createHash("sha256").update(content).digest("base64");
    entries.push([path, `sha256-${hash}`]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new TextEncoder().encode(JSON.stringify(entries));
}

/**
 * Sign a child public key with a parent's private key, producing a
 * chain entry suitable for inclusion in a `BundleSignature.chain`.
 */
export function signChildKey(opts: SignChildKeyOptions): TrustChainEntry {
  const childBytes = Buffer.from(opts.childPublicKey, "base64");
  if (childBytes.length !== 32) {
    throw new Error(`child public key must decode to 32 bytes (got ${childBytes.length})`);
  }
  const parentKey = importPrivateKey(opts.parentPrivateKey);
  const sig = nodeSign(null, childBytes, parentKey);
  return {
    keyId: opts.childKeyId,
    publicKey: opts.childPublicKey,
    signature: sig.toString("base64"),
    parentKeyId: opts.parentKeyId,
  };
}

/**
 * Verify a detached signature document against bundle bytes and a
 * trust root. Returns a structured result — callers choose their own
 * failure policy (fail-closed, log-and-continue, etc.).
 */
export function verifyBundleSignature(
  bundleBytes: Uint8Array,
  signatureDoc: unknown,
  trustRoot: TrustRoot,
): VerifySignatureResult {
  const parsed = parseSignatureDoc(signatureDoc);
  if (!parsed.ok) return parsed;
  const { doc } = parsed;

  if (doc.alg !== "ed25519") {
    return { ok: false, reason: "alg_unsupported", detail: String(doc.alg) };
  }

  const resolved = resolveSigningKey(doc, trustRoot);
  if (!resolved.ok) return resolved;

  const sigBytes = Buffer.from(doc.signature, "base64");
  if (sigBytes.length !== 64) {
    return { ok: false, reason: "malformed", detail: "signature must decode to 64 bytes" };
  }

  const pubKeyObj = importPublicKey(resolved.publicKey);
  const valid = nodeVerify(null, bundleBytes, pubKeyObj, sigBytes);
  if (!valid) return { ok: false, reason: "signature_invalid" };

  return { ok: true, keyId: doc.keyId };
}

/**
 * Read and parse `signature.sig` from a bundle's root package. Returns
 * `null` when no signature is present or the file is not a valid
 * signature document (callers who require signing should treat `null`
 * as "unsigned" and apply their policy).
 */
export function readBundleSignature(bundle: Bundle): BundleSignature | null {
  const rootPkg = bundle.packages.get(bundle.root);
  const raw = rootPkg?.files.get("signature.sig");
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8").decode(raw));
  } catch {
    return null;
  }
  const result = parseSignatureDoc(parsed);
  return result.ok ? result.doc : null;
}

/**
 * Sigstore keyless verification stub (ADR-009 Phase v2).
 *
 * The runtime reserves this API so Phase 11 can wire in `cosign`-
 * compatible verification (Fulcio cert chain + Rekor inclusion proof)
 * without reshaping the consumer interface. Today it always fails
 * with `alg_unsupported`; consumers that see this reason should fall
 * back to Ed25519 verification or reject the bundle per their policy.
 */
export function verifySigstoreSignature(
  _bundleBytes: Uint8Array,
  _signatureBundle: unknown,
): VerifySignatureResult {
  return {
    ok: false,
    reason: "alg_unsupported",
    detail: "Sigstore keyless verification not yet implemented (scheduled for Phase 11)",
  };
}

// ─── internals ──────────────────────────────────────────────────────

function parseSignatureDoc(
  raw: unknown,
): { ok: true; doc: BundleSignature } | { ok: false; reason: "malformed"; detail: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "malformed", detail: "signature document must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.alg !== "string" ||
    typeof obj.keyId !== "string" ||
    typeof obj.signature !== "string"
  ) {
    return { ok: false, reason: "malformed", detail: "missing alg/keyId/signature" };
  }
  if (obj.chain !== undefined) {
    if (!Array.isArray(obj.chain)) {
      return { ok: false, reason: "malformed", detail: "chain must be an array" };
    }
    for (const entry of obj.chain) {
      if (typeof entry !== "object" || entry === null) {
        return { ok: false, reason: "malformed", detail: "chain entry must be an object" };
      }
      const e = entry as Record<string, unknown>;
      if (
        typeof e.keyId !== "string" ||
        typeof e.publicKey !== "string" ||
        typeof e.signature !== "string"
      ) {
        return {
          ok: false,
          reason: "malformed",
          detail: "chain entry missing keyId/publicKey/signature",
        };
      }
      if (e.parentKeyId !== undefined && typeof e.parentKeyId !== "string") {
        return { ok: false, reason: "malformed", detail: "chain entry parentKeyId must be string" };
      }
    }
  }
  return { ok: true, doc: obj as unknown as BundleSignature };
}

function resolveSigningKey(
  doc: BundleSignature,
  trustRoot: TrustRoot,
):
  | { ok: true; publicKey: string }
  | { ok: false; reason: VerifySignatureFailureReason; detail?: string } {
  const direct = trustRoot.keys.find((k) => k.keyId === doc.keyId);
  if (direct) return { ok: true, publicKey: direct.publicKey };

  const chain = doc.chain ?? [];
  if (chain.length === 0) {
    return {
      ok: false,
      reason: "chain_missing",
      detail: `signing keyId ${doc.keyId} not in trust root and no chain provided`,
    };
  }

  const byKeyId = new Map(chain.map((e) => [e.keyId, e] as const));
  const signingEntry = byKeyId.get(doc.keyId);
  if (!signingEntry) {
    return {
      ok: false,
      reason: "chain_missing",
      detail: `signing keyId ${doc.keyId} not in chain`,
    };
  }

  const seen = new Set<string>();
  let current = signingEntry;
  for (;;) {
    if (seen.has(current.keyId)) {
      return { ok: false, reason: "chain_invalid", detail: "chain loop detected" };
    }
    seen.add(current.keyId);

    const parentId = current.parentKeyId;
    if (!parentId) {
      return {
        ok: false,
        reason: "chain_untrusted",
        detail: `chain root ${current.keyId} not trusted`,
      };
    }

    const rootedParent = trustRoot.keys.find((k) => k.keyId === parentId);
    const parentEntry = byKeyId.get(parentId);
    if (!rootedParent && !parentEntry) {
      // Claimed parent is neither trusted nor present in the chain —
      // the signer has pointed at an ancestor the verifier cannot reach.
      return {
        ok: false,
        reason: "chain_untrusted",
        detail: `parent ${parentId} not in trust root or chain`,
      };
    }
    const parentPub = (rootedParent?.publicKey ?? parentEntry?.publicKey)!;

    const childPubBytes = Buffer.from(current.publicKey, "base64");
    const sigBytes = Buffer.from(current.signature, "base64");
    if (childPubBytes.length !== 32 || sigBytes.length !== 64) {
      return {
        ok: false,
        reason: "malformed",
        detail: "chain entry public key must be 32 bytes and signature 64 bytes",
      };
    }
    const parentKeyObj = importPublicKey(parentPub);
    const verified = nodeVerify(null, childPubBytes, parentKeyObj, sigBytes);
    if (!verified) {
      return {
        ok: false,
        reason: "chain_invalid",
        detail: `signature on ${current.keyId} is not valid under parent ${parentId}`,
      };
    }

    if (rootedParent) {
      return { ok: true, publicKey: signingEntry.publicKey };
    }

    // Move up the chain — parentEntry is guaranteed defined when not rooted.
    current = parentEntry!;
  }
}

function rawFromPublicKey(key: KeyObject): Uint8Array {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("Ed25519 public key missing `x` coordinate");
  return Buffer.from(jwk.x, "base64url");
}

function rawFromPrivateKey(key: KeyObject): Uint8Array {
  const jwk = key.export({ format: "jwk" }) as { d?: string };
  if (!jwk.d) throw new Error("Ed25519 private key missing `d` coordinate");
  return Buffer.from(jwk.d, "base64url");
}

function importPublicKey(publicKeyBase64: string): KeyObject {
  const bytes = Buffer.from(publicKeyBase64, "base64");
  if (bytes.length !== 32) {
    throw new Error(`Ed25519 public key must decode to 32 bytes (got ${bytes.length})`);
  }
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") },
    format: "jwk",
  });
}

function importPrivateKey(privateKeyBase64: string): KeyObject {
  const seed = Buffer.from(privateKeyBase64, "base64");
  if (seed.length !== 32) {
    throw new Error(`Ed25519 private-key seed must be 32 bytes (got ${seed.length})`);
  }
  // RFC 8410 §7 PKCS#8 wrapper for a bare Ed25519 seed:
  //   SEQUENCE (46) { INTEGER 0, SEQUENCE { OID 1.3.101.112 },
  //                   OCTET STRING { OCTET STRING(32) <seed> } }
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const pkcs8 = Buffer.concat([prefix, seed]);
  return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}
