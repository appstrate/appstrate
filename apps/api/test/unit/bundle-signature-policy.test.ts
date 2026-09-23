// SPDX-License-Identifier: Apache-2.0

/**
 * Bundle signature policy — unit tests using real Ed25519 keys and
 * real canonical digests (no mocking of crypto). Exercises the three
 * policies against signed, unsigned, and tampered bundles.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { unzipArtifact, zipArtifact } from "@appstrate/core/zip";
import {
  buildBundleFromAfps,
  canonicalBundleDigest,
  emptyPackageCatalog,
  generateKeyPair,
  signBundle,
} from "@appstrate/afps-runtime/bundle";
import {
  BundleSignatureError,
  initBundleSignaturePolicy,
  loadAndVerifyBundle,
  _resetTrustRootCacheForTesting,
} from "../../src/services/run-launcher/bundle-signature-policy.ts";
import {
  _setSystemPackagesForTesting,
  type SystemPackageEntry,
} from "../../src/services/system-packages.ts";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import { logger } from "../../src/lib/logger.ts";

const MINIMAL_MANIFEST = JSON.stringify({
  name: "@testorg/sig-test",
  version: "1.0.0",
  type: "agent",
  description: "Signature policy fixture",
  schema_version: "0.1",
  display_name: "Sig Test",
});

async function buildBundleBytes(opts?: {
  prompt?: string;
  sign?: { keyId: string; privateKey: string };
  manifest?: string;
}) {
  const files: Record<string, Uint8Array> = {
    "manifest.json": new TextEncoder().encode(opts?.manifest ?? MINIMAL_MANIFEST),
    "prompt.md": new TextEncoder().encode(opts?.prompt ?? "Hello {{runId}}"),
  };
  if (opts?.sign) {
    const unsignedZip = zipArtifact(files, 6);
    const unsignedBundle = await buildBundleFromAfps(unsignedZip, emptyPackageCatalog, {
      depTypes: [],
    });
    const digest = canonicalBundleDigest(unsignedBundle);
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
      const bytes = await buildBundleBytes();
      const bundle = await loadAndVerifyBundle(bytes, "@testorg/sig-test");
      expect(bundle).toBeNull();
    });

    it("skips loading and returns null for a bundle with a foreign signature", async () => {
      const foreignKey = generateKeyPair();
      const bytes = await buildBundleBytes({ sign: foreignKey });
      const bundle = await loadAndVerifyBundle(bytes, "@testorg/sig-test");
      expect(bundle).toBeNull();
    });
  });

  describe("policy=required", () => {
    beforeEach(() => setEnv({ AFPS_SIGNATURE_POLICY: "required" }));

    it("refuses a malformed archive", async () => {
      const bytes = new TextEncoder().encode("not a zip");
      await expect(loadAndVerifyBundle(bytes, "@testorg/sig-test")).rejects.toThrow();
    });

    it("rejects an unsigned bundle with code=unsigned_required", async () => {
      const bytes = await buildBundleBytes();
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
      const bytes = await buildBundleBytes({ sign: keypair });
      const bundle = await loadAndVerifyBundle(bytes, "@testorg/sig-test");
      expect(bundle).not.toBeNull();
      expect((bundle!.packages.get(bundle!.root)!.manifest as Record<string, unknown>).name).toBe(
        "@testorg/sig-test",
      );
    });

    it("verifies a signed package that declares dependencies (stored separately)", async () => {
      const manifest = JSON.stringify({
        ...JSON.parse(MINIMAL_MANIFEST),
        dependencies: { skills: { "@testorg/some-skill": "^1.0.0" } },
      });
      const bytes = await buildBundleBytes({ sign: keypair, manifest });
      const bundle = await loadAndVerifyBundle(bytes, "@testorg/sig-test");
      expect(bundle).not.toBeNull();
    });

    it("rejects a bundle signed by an untrusted key with code=chain_missing", async () => {
      const foreignKey = generateKeyPair();
      const bytes = await buildBundleBytes({ sign: foreignKey });
      try {
        await loadAndVerifyBundle(bytes, "@testorg/sig-test");
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(BundleSignatureError);
        expect((err as BundleSignatureError).code).toBe("chain_missing");
      }
    });
  });

  describe("default policy", () => {
    it("is warn: a signed bundle is verified", async () => {
      setEnv({ AFPS_SIGNATURE_POLICY: undefined });
      const bytes = await buildBundleBytes({ sign: keypair });
      expect(await loadAndVerifyBundle(bytes, "@testorg/sig-test")).not.toBeNull();
    });
  });

  describe("system packages", () => {
    it("are exempt even under policy=required (the image is their trust root)", async () => {
      setEnv({ AFPS_SIGNATURE_POLICY: "required" });
      const restore = _setSystemPackagesForTesting(
        new Map([["@testorg/sig-test", { packageId: "@testorg/sig-test" } as SystemPackageEntry]]),
      );
      try {
        const bundle = await loadAndVerifyBundle(await buildBundleBytes(), "@testorg/sig-test");
        expect(bundle).toBeNull();
      } finally {
        restore();
      }
    });
  });

  describe("policy=warn", () => {
    beforeEach(() => setEnv({ AFPS_SIGNATURE_POLICY: "warn" }));

    it("never throws: a malformed archive is logged and passes", async () => {
      const warn = spyOn(logger, "warn");
      try {
        const bytes = new TextEncoder().encode("not a zip");
        expect(await loadAndVerifyBundle(bytes, "@testorg/sig-test")).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it("logs unsigned at debug, an invalid signature at warn", async () => {
      const warn = spyOn(logger, "warn");
      const debug = spyOn(logger, "debug");
      try {
        await loadAndVerifyBundle(await buildBundleBytes(), "@testorg/sig-test");
        expect(warn).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalledWith("AFPS bundle is unsigned", expect.anything());

        const bytes = await buildBundleBytes({ sign: generateKeyPair() });
        await loadAndVerifyBundle(bytes, "@testorg/sig-test");
        expect(warn).toHaveBeenCalledWith("AFPS bundle signature invalid", expect.anything());
      } finally {
        warn.mockRestore();
        debug.mockRestore();
      }
    });

    it("skips parsing an unsigned archive: the central directory has no signature entry", async () => {
      // A manifest the loader would refuse proves no parse happened: parsed,
      // it would be logged at warn as "could not be checked".
      const warn = spyOn(logger, "warn");
      try {
        const bytes = await buildBundleBytes({ manifest: "{ not json" });
        expect(await loadAndVerifyBundle(bytes, "@testorg/sig-test")).toBeNull();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it("finds a signature under a wrapper folder", async () => {
      const foreign = await buildBundleBytes({ sign: generateKeyPair() });
      const wrapped = zipArtifact(
        Object.fromEntries(
          Object.entries(unzipArtifact(foreign)).map(([name, bytes]) => [`pkg/${name}`, bytes]),
        ),
        6,
      );
      const warn = spyOn(logger, "warn");
      try {
        expect(await loadAndVerifyBundle(wrapped, "@testorg/sig-test")).not.toBeNull();
        expect(warn).toHaveBeenCalledWith("AFPS bundle signature invalid", expect.anything());
      } finally {
        warn.mockRestore();
      }
    });

    it("accepts a signed bundle with an invalid signature (warn only)", async () => {
      const foreignKey = generateKeyPair();
      const bytes = await buildBundleBytes({ sign: foreignKey });
      const bundle = await loadAndVerifyBundle(bytes, "@testorg/sig-test");
      expect(bundle).not.toBeNull();
      expect((bundle!.packages.get(bundle!.root)!.manifest as Record<string, unknown>).name).toBe(
        "@testorg/sig-test",
      );
    });

    it("accepts a bundle signed by a trusted key", async () => {
      const bytes = await buildBundleBytes({ sign: keypair });
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
      const bytes = await buildBundleBytes({ sign: keypair });
      await expect(loadAndVerifyBundle(bytes, "@testorg/sig-test")).rejects.toThrow(
        /AFPS_TRUST_ROOT/,
      );
    });

    it("initBundleSignaturePolicy fails boot on a malformed AFPS_TRUST_ROOT, whatever the policy", () => {
      setEnv({
        AFPS_TRUST_ROOT: JSON.stringify([{ keyId: "k1" /* publicKey missing */ }]),
        AFPS_SIGNATURE_POLICY: "off",
      });
      expect(() => initBundleSignaturePolicy()).toThrow(/AFPS_TRUST_ROOT\[0\]/);
    });

    it("fails fast when a publicKey does not decode to 32 bytes", async () => {
      setEnv({
        AFPS_TRUST_ROOT: JSON.stringify([
          { keyId: "k1", publicKey: Buffer.from("short").toString("base64") },
        ]),
        AFPS_SIGNATURE_POLICY: "required",
      });
      const bytes = await buildBundleBytes({ sign: keypair });
      await expect(loadAndVerifyBundle(bytes, "@testorg/sig-test")).rejects.toThrow(/32 bytes/);
    });
  });
});
