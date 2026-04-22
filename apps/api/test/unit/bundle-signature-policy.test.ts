// SPDX-License-Identifier: Apache-2.0

/**
 * Bundle signature policy — unit tests using real Ed25519 keys and
 * real canonical digests (no mocking of crypto). Exercises the three
 * policies against signed, unsigned, and tampered bundles.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { zipArtifact } from "@appstrate/core/zip";
import { canonicalBundleDigest, generateKeyPair, signBundle } from "@appstrate/afps-runtime/bundle";
import {
  BundleSignatureError,
  loadAndVerifyBundle,
  _resetTrustRootCacheForTesting,
} from "../../src/services/adapters/bundle-signature-policy.ts";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";

const MINIMAL_MANIFEST = JSON.stringify({
  name: "@testorg/sig-test",
  version: "1.0.0",
  type: "agent",
  description: "Signature policy fixture",
  schemaVersion: "1.1",
});

function buildBundleBytes(opts?: {
  prompt?: string;
  sign?: { keyId: string; privateKey: string };
}) {
  const files: Record<string, Uint8Array> = {
    "manifest.json": new TextEncoder().encode(MINIMAL_MANIFEST),
    "prompt.md": new TextEncoder().encode(opts?.prompt ?? "Hello {{runId}}"),
  };
  if (opts?.sign) {
    const digest = canonicalBundleDigest(files);
    const signature = signBundle(digest, {
      keyId: opts.sign.keyId,
      privateKey: opts.sign.privateKey,
    });
    files["signature.sig"] = new TextEncoder().encode(JSON.stringify(signature));
  }
  return zipArtifact(files, 6);
}

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
  _resetTrustRootCacheForTesting();
}

describe("BundleSignaturePolicy", () => {
  let keypair: ReturnType<typeof generateKeyPair>;
  let originalTrustRoot: string | undefined;
  let originalPolicy: string | undefined;

  beforeEach(() => {
    originalTrustRoot = process.env.AFPS_TRUST_ROOT;
    originalPolicy = process.env.AFPS_SIGNATURE_POLICY;
    keypair = generateKeyPair();
    setEnv({
      AFPS_TRUST_ROOT: JSON.stringify([
        { keyId: keypair.keyId, publicKey: keypair.publicKey, comment: "test" },
      ]),
    });
  });

  // Restore env after each test — `policy=required` cases would
  // otherwise leak into adjacent files in the same `bun test` run and
  // cause every other catalog/bundle path to crash with `unsigned_required`.
  afterEach(() => {
    setEnv({ AFPS_TRUST_ROOT: originalTrustRoot, AFPS_SIGNATURE_POLICY: originalPolicy });
  });
  afterAll(() => {
    setEnv({ AFPS_TRUST_ROOT: originalTrustRoot, AFPS_SIGNATURE_POLICY: originalPolicy });
  });

  describe("policy=off", () => {
    beforeEach(() => setEnv({ AFPS_SIGNATURE_POLICY: "off" }));

    // Under policy=off the function short-circuits BEFORE invoking the
    // legacy single-package loader so callers can ingest non-agent
    // archives (skills, tools, providers) through the same pathway
    // without tripping the prompt.md requirement. The return value
    // signals "skipped" with `null`.
    it("skips loading and returns null for an unsigned bundle", async () => {
      const bytes = buildBundleBytes();
      const bundle = await loadAndVerifyBundle(bytes, "@testorg/sig-test");
      expect(bundle).toBeNull();
    });

    it("skips loading and returns null for a bundle with a foreign signature", async () => {
      const foreignKey = generateKeyPair();
      const bytes = buildBundleBytes({ sign: foreignKey });
      const bundle = await loadAndVerifyBundle(bytes, "@testorg/sig-test");
      expect(bundle).toBeNull();
    });
  });

  describe("policy=required", () => {
    beforeEach(() => setEnv({ AFPS_SIGNATURE_POLICY: "required" }));

    it("rejects an unsigned bundle with code=unsigned_required", async () => {
      const bytes = buildBundleBytes();
      await expect(loadAndVerifyBundle(bytes, "@testorg/sig-test")).rejects.toThrow(
        BundleSignatureError,
      );
      try {
        await loadAndVerifyBundle(bytes, "@testorg/sig-test");
      } catch (err) {
        expect(err).toBeInstanceOf(BundleSignatureError);
        expect((err as BundleSignatureError).code).toBe("unsigned_required");
        expect((err as BundleSignatureError).packageId).toBe("@testorg/sig-test");
      }
    });

    it("accepts a bundle signed by a trusted key", async () => {
      const bytes = buildBundleBytes({ sign: keypair });
      const bundle = await loadAndVerifyBundle(bytes, "@testorg/sig-test");
      expect(bundle).not.toBeNull();
      expect((bundle!.packages.get(bundle!.root)!.manifest as Record<string, unknown>).name).toBe(
        "@testorg/sig-test",
      );
    });

    it("rejects a bundle signed by an untrusted key with code=chain_missing", async () => {
      const foreignKey = generateKeyPair();
      const bytes = buildBundleBytes({ sign: foreignKey });
      try {
        await loadAndVerifyBundle(bytes, "@testorg/sig-test");
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(BundleSignatureError);
        expect((err as BundleSignatureError).code).toBe("chain_missing");
      }
    });
  });

  describe("policy=warn", () => {
    beforeEach(() => setEnv({ AFPS_SIGNATURE_POLICY: "warn" }));

    it("accepts an unsigned bundle (warn only)", async () => {
      const bytes = buildBundleBytes();
      const bundle = await loadAndVerifyBundle(bytes, "@testorg/sig-test");
      expect(bundle).not.toBeNull();
      expect((bundle!.packages.get(bundle!.root)!.manifest as Record<string, unknown>).name).toBe(
        "@testorg/sig-test",
      );
    });

    it("accepts a signed bundle with an invalid signature (warn only)", async () => {
      const foreignKey = generateKeyPair();
      const bytes = buildBundleBytes({ sign: foreignKey });
      const bundle = await loadAndVerifyBundle(bytes, "@testorg/sig-test");
      expect(bundle).not.toBeNull();
      expect((bundle!.packages.get(bundle!.root)!.manifest as Record<string, unknown>).name).toBe(
        "@testorg/sig-test",
      );
    });

    it("accepts a bundle signed by a trusted key", async () => {
      const bytes = buildBundleBytes({ sign: keypair });
      const bundle = await loadAndVerifyBundle(bytes, "@testorg/sig-test");
      expect(bundle).not.toBeNull();
      expect((bundle!.packages.get(bundle!.root)!.manifest as Record<string, unknown>).name).toBe(
        "@testorg/sig-test",
      );
    });
  });

  describe("trust root parsing", () => {
    it("fails fast on a malformed AFPS_TRUST_ROOT entry", async () => {
      setEnv({
        AFPS_TRUST_ROOT: JSON.stringify([{ keyId: "k1" /* publicKey missing */ }]),
        AFPS_SIGNATURE_POLICY: "required",
      });
      const bytes = buildBundleBytes({ sign: keypair });
      await expect(loadAndVerifyBundle(bytes, "@testorg/sig-test")).rejects.toThrow(
        /AFPS_TRUST_ROOT/,
      );
    });

    it("fails fast when a publicKey does not decode to 32 bytes", async () => {
      setEnv({
        AFPS_TRUST_ROOT: JSON.stringify([
          { keyId: "k1", publicKey: Buffer.from("short").toString("base64") },
        ]),
        AFPS_SIGNATURE_POLICY: "required",
      });
      const bytes = buildBundleBytes({ sign: keypair });
      await expect(loadAndVerifyBundle(bytes, "@testorg/sig-test")).rejects.toThrow(/32 bytes/);
    });
  });
});
