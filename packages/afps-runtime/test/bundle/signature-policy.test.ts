// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  verifyBundleWithPolicy,
  BundleSignaturePolicyError,
} from "../../src/bundle/signature-policy.ts";
import {
  canonicalBundleDigest,
  generateKeyPair,
  signBundle,
  type TrustRoot,
} from "../../src/bundle/signing.ts";
import { writeBundleToBuffer } from "../../src/bundle/write.ts";
import { readBundleFromBuffer } from "../../src/bundle/read.ts";
import {
  recordIntegrity,
  serializeRecord,
  computeRecordEntries,
} from "../../src/bundle/integrity.ts";
import type { Bundle, BundlePackage } from "../../src/bundle/types.ts";
import { bundleIntegrity } from "../../src/bundle/integrity.ts";

function manifestBytes(manifest: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

async function makeBundle({ sign }: { sign: boolean }): Promise<{
  bundle: Bundle;
  trustRoot: TrustRoot;
}> {
  const kp = await generateKeyPair();
  const trustRoot: TrustRoot = { keys: [{ keyId: kp.keyId, publicKey: kp.publicKey }] };

  const manifest = {
    type: "agent",
    name: "@acme/bundle",
    version: "1.0.0",
    schemaVersion: "1.0.0",
  };
  const prompt = new TextEncoder().encode("Prompt body");
  const files = new Map<string, Uint8Array>([
    ["manifest.json", manifestBytes(manifest)],
    ["prompt.md", prompt],
  ]);

  const identity = "@acme/bundle@1.0.0";
  const pkg: BundlePackage = {
    identity,
    manifest,
    files,
    integrity: recordIntegrity(serializeRecord(computeRecordEntries(files))),
  };
  const integrity = bundleIntegrity(
    new Map([[identity, { path: `packages/@acme/bundle/1.0.0/`, integrity: pkg.integrity }]]),
  );
  let bundle: Bundle = {
    bundleFormatVersion: "1.0",
    root: identity,
    packages: new Map([[identity, pkg]]),
    integrity,
  };

  if (sign) {
    const digest = canonicalBundleDigest(bundle);
    const signature = signBundle(digest, { privateKey: kp.privateKey, keyId: kp.keyId });
    const filesWithSig = new Map(files);
    filesWithSig.set(
      "signature.sig",
      new TextEncoder().encode(JSON.stringify(signature, null, 2) + "\n"),
    );
    const buf = writeBundleToBuffer({
      ...bundle,
      packages: new Map([
        [
          identity,
          {
            ...pkg,
            files: filesWithSig,
            integrity: recordIntegrity(serializeRecord(computeRecordEntries(filesWithSig))),
          },
        ],
      ]),
    });
    bundle = readBundleFromBuffer(buf);
  }

  return { bundle, trustRoot };
}

describe("verifyBundleWithPolicy", () => {
  it("policy 'off' returns immediately without consulting the trust root", async () => {
    const { bundle } = await makeBundle({ sign: false });
    const outcome = verifyBundleWithPolicy(bundle, { policy: "off" });
    expect(outcome.status).toBe("off");
  });

  it("policy 'warn' invokes onWarn('unsigned') on an unsigned bundle", async () => {
    const { bundle, trustRoot } = await makeBundle({ sign: false });
    const warnings: string[] = [];
    const outcome = verifyBundleWithPolicy(bundle, {
      policy: "warn",
      trustRoot,
      onWarn: (reason) => warnings.push(reason),
    });
    expect(outcome.status).toBe("unsigned-warned");
    expect(warnings).toEqual(["unsigned"]);
  });

  it("policy 'required' throws on unsigned bundles", async () => {
    const { bundle, trustRoot } = await makeBundle({ sign: false });
    let caught: unknown;
    try {
      verifyBundleWithPolicy(bundle, { policy: "required", trustRoot });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleSignaturePolicyError);
    expect((caught as BundleSignaturePolicyError).code).toBe("unsigned_required");
  });

  it("verifies a well-signed bundle under policy 'required'", async () => {
    const { bundle, trustRoot } = await makeBundle({ sign: true });
    let verifiedKeyId: string | undefined;
    const outcome = verifyBundleWithPolicy(bundle, {
      policy: "required",
      trustRoot,
      onVerified: (kid) => {
        verifiedKeyId = kid;
      },
    });
    expect(outcome.status).toBe("verified");
    expect(outcome.keyId).toBeTruthy();
    expect(verifiedKeyId).toBe(outcome.keyId);
  });

  it("rejects a bundle signed with an untrusted key under 'required'", async () => {
    const { bundle } = await makeBundle({ sign: true });
    const otherKp = await generateKeyPair();
    const trustRoot: TrustRoot = {
      keys: [{ keyId: otherKp.keyId, publicKey: otherKp.publicKey }],
    };
    let caught: unknown;
    try {
      verifyBundleWithPolicy(bundle, { policy: "required", trustRoot });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleSignaturePolicyError);
  });

  it("policy 'warn' surfaces signature failures via onWarn instead of throwing", async () => {
    const { bundle } = await makeBundle({ sign: true });
    const otherKp = await generateKeyPair();
    const trustRoot: TrustRoot = {
      keys: [{ keyId: otherKp.keyId, publicKey: otherKp.publicKey }],
    };
    const warnings: Array<{ reason: string; detail?: string }> = [];
    const outcome = verifyBundleWithPolicy(bundle, {
      policy: "warn",
      trustRoot,
      onWarn: (reason, detail) => warnings.push({ reason, ...(detail ? { detail } : {}) }),
    });
    expect(outcome.status).toBe("warned");
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.reason).not.toBe("unsigned");
  });

  it("throws when trustRoot is missing and policy is not 'off'", async () => {
    const { bundle } = await makeBundle({ sign: true });
    let caught: unknown;
    try {
      verifyBundleWithPolicy(bundle, { policy: "required" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleSignaturePolicyError);
  });
});
