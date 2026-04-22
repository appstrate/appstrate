// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { zipSync } from "fflate";
import {
  generateKeyPair,
  keyIdFromPublicKey,
  signBundle,
  signChildKey,
  verifyBundleSignature,
  verifySigstoreSignature,
  readBundleSignature,
  type BundleSignature,
  type TrustRoot,
} from "../../src/bundle/signing.ts";
import { buildBundleFromAfps } from "../../src/bundle/build.ts";
import { emptyPackageCatalog } from "../../src/bundle/catalog.ts";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const MINIMAL_MANIFEST = {
  name: "@acme/hello",
  version: "1.0.0",
  type: "agent",
  schemaVersion: "1.1",
  displayName: "Hello",
  author: "Acme",
};

describe("generateKeyPair", () => {
  it("produces base64 32-byte keys", () => {
    const kp = generateKeyPair();
    expect(Buffer.from(kp.publicKey, "base64").length).toBe(32);
    expect(Buffer.from(kp.privateKey, "base64").length).toBe(32);
    expect(kp.keyId).toMatch(/^[a-f0-9]{16}$/);
  });

  it("produces distinct key pairs on each call", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe("keyIdFromPublicKey", () => {
  it("is deterministic for the same public key", () => {
    const kp = generateKeyPair();
    expect(keyIdFromPublicKey(kp.publicKey)).toBe(keyIdFromPublicKey(kp.publicKey));
  });

  it("accepts both base64 string and raw bytes", () => {
    const kp = generateKeyPair();
    const raw = Buffer.from(kp.publicKey, "base64");
    expect(keyIdFromPublicKey(kp.publicKey)).toBe(keyIdFromPublicKey(raw));
  });
});

describe("signBundle + verifyBundleSignature — direct trust", () => {
  it("verifies a self-signed bundle when the signing key is in the trust root", () => {
    const root = generateKeyPair();
    const bundle = enc("pretend this is a zip");
    const doc = signBundle(bundle, { privateKey: root.privateKey, keyId: root.keyId });

    expect(doc.alg).toBe("ed25519");
    expect(doc.keyId).toBe(root.keyId);
    expect(doc.chain).toBeUndefined();

    const trustRoot: TrustRoot = { keys: [{ keyId: root.keyId, publicKey: root.publicKey }] };
    const r = verifyBundleSignature(bundle, doc, trustRoot);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.keyId).toBe(root.keyId);
  });

  it("fails when a single byte of the bundle is tampered", () => {
    const root = generateKeyPair();
    const bundle = enc("original bundle");
    const doc = signBundle(bundle, { privateKey: root.privateKey, keyId: root.keyId });

    const tampered = new Uint8Array(bundle);
    tampered[0] = tampered[0]! ^ 0xff;

    const trustRoot: TrustRoot = { keys: [{ keyId: root.keyId, publicKey: root.publicKey }] };
    const r = verifyBundleSignature(tampered, doc, trustRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("signature_invalid");
  });

  it("fails with chain_missing when the signer is not in the trust root and no chain is provided", () => {
    const signer = generateKeyPair();
    const other = generateKeyPair();
    const bundle = enc("x");
    const doc = signBundle(bundle, { privateKey: signer.privateKey, keyId: signer.keyId });

    const trustRoot: TrustRoot = { keys: [{ keyId: other.keyId, publicKey: other.publicKey }] };
    const r = verifyBundleSignature(bundle, doc, trustRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("chain_missing");
  });
});

describe("signChildKey + verifyBundleSignature — trust chain", () => {
  it("verifies a bundle signed by a publisher whose key is signed by a trusted root", () => {
    const root = generateKeyPair();
    const publisher = generateKeyPair();
    const bundle = enc("bundle bytes");

    const chainEntry = signChildKey({
      childKeyId: publisher.keyId,
      childPublicKey: publisher.publicKey,
      parentPrivateKey: root.privateKey,
      parentKeyId: root.keyId,
    });

    const doc = signBundle(bundle, {
      privateKey: publisher.privateKey,
      keyId: publisher.keyId,
      chain: [chainEntry],
    });
    expect(doc.chain).toHaveLength(1);

    const trustRoot: TrustRoot = { keys: [{ keyId: root.keyId, publicKey: root.publicKey }] };
    const r = verifyBundleSignature(bundle, doc, trustRoot);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.keyId).toBe(publisher.keyId);
  });

  it("rejects a chain whose publisher key was not actually signed by the claimed parent", () => {
    const root = generateKeyPair();
    const impostor = generateKeyPair();
    const publisher = generateKeyPair();
    const bundle = enc("bundle bytes");

    // Publisher's key signed by impostor, but chain claims root as parent.
    const real = signChildKey({
      childKeyId: publisher.keyId,
      childPublicKey: publisher.publicKey,
      parentPrivateKey: impostor.privateKey,
      parentKeyId: root.keyId, // lie about who signed it
    });

    const doc = signBundle(bundle, {
      privateKey: publisher.privateKey,
      keyId: publisher.keyId,
      chain: [real],
    });

    const trustRoot: TrustRoot = { keys: [{ keyId: root.keyId, publicKey: root.publicKey }] };
    const r = verifyBundleSignature(bundle, doc, trustRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("chain_invalid");
  });

  it("rejects a chain whose root is not in the trust root", () => {
    const unknownRoot = generateKeyPair();
    const publisher = generateKeyPair();
    const actualTrusted = generateKeyPair();
    const bundle = enc("bundle");

    const chainEntry = signChildKey({
      childKeyId: publisher.keyId,
      childPublicKey: publisher.publicKey,
      parentPrivateKey: unknownRoot.privateKey,
      parentKeyId: unknownRoot.keyId,
    });
    const doc = signBundle(bundle, {
      privateKey: publisher.privateKey,
      keyId: publisher.keyId,
      chain: [chainEntry],
    });

    const trustRoot: TrustRoot = {
      keys: [{ keyId: actualTrusted.keyId, publicKey: actualTrusted.publicKey }],
    };
    const r = verifyBundleSignature(bundle, doc, trustRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("chain_untrusted");
  });

  it("verifies a two-hop chain: root → intermediate → publisher", () => {
    const root = generateKeyPair();
    const intermediate = generateKeyPair();
    const publisher = generateKeyPair();
    const bundle = enc("bundle");

    const intermediateEntry = signChildKey({
      childKeyId: intermediate.keyId,
      childPublicKey: intermediate.publicKey,
      parentPrivateKey: root.privateKey,
      parentKeyId: root.keyId,
    });
    const publisherEntry = signChildKey({
      childKeyId: publisher.keyId,
      childPublicKey: publisher.publicKey,
      parentPrivateKey: intermediate.privateKey,
      parentKeyId: intermediate.keyId,
    });

    const doc = signBundle(bundle, {
      privateKey: publisher.privateKey,
      keyId: publisher.keyId,
      chain: [publisherEntry, intermediateEntry],
    });

    const trustRoot: TrustRoot = { keys: [{ keyId: root.keyId, publicKey: root.publicKey }] };
    const r = verifyBundleSignature(bundle, doc, trustRoot);
    expect(r.ok).toBe(true);
  });

  it("detects a chain loop", () => {
    const root = generateKeyPair();
    const a = generateKeyPair();
    const b = generateKeyPair();
    const bundle = enc("bundle");

    // a ← b ← a  (loop)
    const aSignedByB = signChildKey({
      childKeyId: a.keyId,
      childPublicKey: a.publicKey,
      parentPrivateKey: b.privateKey,
      parentKeyId: b.keyId,
    });
    const bSignedByA = signChildKey({
      childKeyId: b.keyId,
      childPublicKey: b.publicKey,
      parentPrivateKey: a.privateKey,
      parentKeyId: a.keyId,
    });

    const doc = signBundle(bundle, {
      privateKey: a.privateKey,
      keyId: a.keyId,
      chain: [aSignedByB, bSignedByA],
    });

    const trustRoot: TrustRoot = { keys: [{ keyId: root.keyId, publicKey: root.publicKey }] };
    const r = verifyBundleSignature(bundle, doc, trustRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("chain_invalid");
  });
});

describe("verifyBundleSignature — malformed / unsupported", () => {
  const trustRoot: TrustRoot = { keys: [] };

  it("rejects a document that is not a JSON object", () => {
    const r = verifyBundleSignature(enc("x"), "not-an-object", trustRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  it("rejects a document missing required fields", () => {
    const r = verifyBundleSignature(enc("x"), { alg: "ed25519" }, trustRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  it("rejects an unsupported algorithm", () => {
    const r = verifyBundleSignature(
      enc("x"),
      { alg: "rsa", keyId: "k", signature: "AAAA" },
      trustRoot,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("alg_unsupported");
  });

  it("rejects a chain that is not an array", () => {
    const r = verifyBundleSignature(
      enc("x"),
      { alg: "ed25519", keyId: "k", signature: "AAAA", chain: "nope" },
      trustRoot,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  it("rejects a signature that doesn't decode to 64 bytes", () => {
    const kp = generateKeyPair();
    const doc: BundleSignature = {
      alg: "ed25519",
      keyId: kp.keyId,
      signature: Buffer.from("short").toString("base64"),
    };
    const r = verifyBundleSignature(enc("x"), doc, {
      keys: [{ keyId: kp.keyId, publicKey: kp.publicKey }],
    } as TrustRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });
});

describe("readBundleSignature", () => {
  it("reads and parses signature.sig from a loaded bundle", async () => {
    const kp = generateKeyPair();
    const inner = enc("sentinel");
    const sig = signBundle(inner, { privateKey: kp.privateKey, keyId: kp.keyId });

    const zip = zipSync({
      "manifest.json": enc(JSON.stringify(MINIMAL_MANIFEST)),
      "prompt.md": enc("p"),
      "signature.sig": enc(JSON.stringify(sig)),
    });
    const bundle = await buildBundleFromAfps(zip, emptyPackageCatalog);
    const read = readBundleSignature(bundle);
    expect(read).not.toBeNull();
    expect(read!.keyId).toBe(kp.keyId);
    expect(read!.alg).toBe("ed25519");
  });

  it("returns null when signature.sig is absent", async () => {
    const zip = zipSync({
      "manifest.json": enc(JSON.stringify(MINIMAL_MANIFEST)),
      "prompt.md": enc("p"),
    });
    const bundle = await buildBundleFromAfps(zip, emptyPackageCatalog);
    expect(readBundleSignature(bundle)).toBeNull();
  });

  it("returns null when signature.sig is not valid JSON", async () => {
    const zip = zipSync({
      "manifest.json": enc(JSON.stringify(MINIMAL_MANIFEST)),
      "prompt.md": enc("p"),
      "signature.sig": enc("{not-json"),
    });
    const bundle = await buildBundleFromAfps(zip, emptyPackageCatalog);
    expect(readBundleSignature(bundle)).toBeNull();
  });

  it("returns null when signature.sig is JSON but malformed", async () => {
    const zip = zipSync({
      "manifest.json": enc(JSON.stringify(MINIMAL_MANIFEST)),
      "prompt.md": enc("p"),
      "signature.sig": enc(JSON.stringify({ alg: "ed25519" })),
    });
    const bundle = await buildBundleFromAfps(zip, emptyPackageCatalog);
    expect(readBundleSignature(bundle)).toBeNull();
  });
});

describe("verifySigstoreSignature (stub)", () => {
  it("always fails with alg_unsupported for now", () => {
    const r = verifySigstoreSignature(enc("x"), {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("alg_unsupported");
      expect(r.detail).toContain("Phase 11");
    }
  });
});
