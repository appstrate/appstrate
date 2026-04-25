// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/index.ts";
import { captureIo, writeBundleFile, writeJsonFile } from "./helpers.ts";
import { generateKeyPair, readBundleSignature, signChildKey } from "../../src/bundle/signing.ts";
import { readBundleFromFile } from "../../src/bundle/read.ts";

describe("afps sign + verify — round trip", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "afps-cli-sign-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("signs a bundle in place and the loaded bundle surfaces the signature", async () => {
    const bundlePath = join(dir, "agent.afps");
    const keyPath = join(dir, "key.json");
    await writeBundleFile(bundlePath);

    const kp = generateKeyPair();
    await writeJsonFile(keyPath, kp);

    const io = captureIo();
    const code = await runCli(["sign", bundlePath, "--key", keyPath], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain(`keyId: ${kp.keyId}`);

    const loaded = await readBundleFromFile(bundlePath);
    const sig = readBundleSignature(loaded);
    expect(sig).not.toBeNull();
    expect(sig!.keyId).toBe(kp.keyId);
    expect(sig!.alg).toBe("ed25519");
  });

  it("writes the signed bundle to --out when provided", async () => {
    const bundlePath = join(dir, "agent.afps");
    const outPath = join(dir, "agent-signed.afps");
    const keyPath = join(dir, "key.json");
    await writeBundleFile(bundlePath);
    const kp = generateKeyPair();
    await writeJsonFile(keyPath, kp);

    const code = await runCli(
      ["sign", bundlePath, "--key", keyPath, "--out", outPath],
      captureIo(),
    );
    expect(code).toBe(0);

    const originalSig = readBundleSignature(await readBundleFromFile(bundlePath));
    expect(originalSig).toBeNull();
    const copySig = readBundleSignature(await readBundleFromFile(outPath));
    expect(copySig).not.toBeNull();
  });

  it("round-trips through verify with a matching trust root", async () => {
    const bundlePath = join(dir, "agent.afps");
    const keyPath = join(dir, "key.json");
    const trustPath = join(dir, "trust.json");
    await writeBundleFile(bundlePath);

    const kp = generateKeyPair();
    await writeJsonFile(keyPath, kp);
    await writeJsonFile(trustPath, {
      keys: [{ keyId: kp.keyId, publicKey: kp.publicKey }],
    });
    await runCli(["sign", bundlePath, "--key", keyPath], captureIo());

    const io = captureIo();
    const code = await runCli(["verify", bundlePath, "--trust-root", trustPath], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("bundle valid");
    expect(io.stdoutText()).toContain("signature valid");
    expect(io.stdoutText()).toContain(kp.keyId);
  });

  it("detects tampering after signing", async () => {
    const bundlePath = join(dir, "agent.afps");
    const keyPath = join(dir, "key.json");
    const trustPath = join(dir, "trust.json");
    await writeBundleFile(bundlePath);
    const kp = generateKeyPair();
    await writeJsonFile(keyPath, kp);
    await writeJsonFile(trustPath, {
      keys: [{ keyId: kp.keyId, publicKey: kp.publicKey }],
    });
    await runCli(["sign", bundlePath, "--key", keyPath], captureIo());

    // Re-pack with tampered prompt but keep the old signature.sig.
    // Build a fresh .afps-bundle with the tampered prompt + preserved sig.
    const loaded = await readBundleFromFile(bundlePath);
    const rootPkg = loaded.packages.get(loaded.root)!;
    const sigBytes = rootPkg.files.get("signature.sig")!;
    const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
    const { writeBundleToBuffer } = await import("../../src/bundle/write.ts");
    const { BUNDLE_FORMAT_VERSION } = await import("../../src/bundle/types.ts");
    const { bundleIntegrity, computeRecordEntries, recordIntegrity, serializeRecord } =
      await import("../../src/bundle/integrity.ts");
    const tamperedFiles = new Map(rootPkg.files);
    tamperedFiles.set("prompt.md", encode("TAMPERED — different content than what was signed."));
    tamperedFiles.set("signature.sig", sigBytes);
    const integrity = recordIntegrity(serializeRecord(computeRecordEntries(tamperedFiles)));
    const tamperedBundle = {
      bundleFormatVersion: BUNDLE_FORMAT_VERSION,
      root: loaded.root,
      packages: new Map([[loaded.root, { ...rootPkg, files: tamperedFiles, integrity }]]),
      integrity: bundleIntegrity(
        new Map([
          [
            loaded.root,
            {
              path: `packages/${(rootPkg.manifest as { name: string }).name}/${(rootPkg.manifest as { version: string }).version}/`,
              integrity,
            },
          ],
        ]),
      ),
    };
    await writeFile(bundlePath, writeBundleToBuffer(tamperedBundle));

    const io = captureIo();
    const code = await runCli(["verify", bundlePath, "--trust-root", trustPath], io);
    expect(code).toBe(3);
    expect(io.stderrText()).toContain("signature verification failed");
    expect(io.stderrText()).toContain("signature_invalid");
  });

  it("reports an untrusted signer under a mismatched trust root", async () => {
    const bundlePath = join(dir, "agent.afps");
    const keyPath = join(dir, "key.json");
    const wrongTrustPath = join(dir, "wrong-trust.json");
    await writeBundleFile(bundlePath);
    const kp = generateKeyPair();
    const other = generateKeyPair();
    await writeJsonFile(keyPath, kp);
    await writeJsonFile(wrongTrustPath, {
      keys: [{ keyId: other.keyId, publicKey: other.publicKey }],
    });
    await runCli(["sign", bundlePath, "--key", keyPath], captureIo());

    const io = captureIo();
    const code = await runCli(["verify", bundlePath, "--trust-root", wrongTrustPath], io);
    expect(code).toBe(3);
    expect(io.stderrText()).toContain("chain_missing");
  });

  it("verifies a bundle signed with a chain linking to a trusted root", async () => {
    const bundlePath = join(dir, "agent.afps");
    const keyPath = join(dir, "publisher.json");
    const chainPath = join(dir, "chain.json");
    const trustPath = join(dir, "trust.json");
    await writeBundleFile(bundlePath);

    const root = generateKeyPair();
    const publisher = generateKeyPair();
    const chainEntry = signChildKey({
      childKeyId: publisher.keyId,
      childPublicKey: publisher.publicKey,
      parentPrivateKey: root.privateKey,
      parentKeyId: root.keyId,
    });
    await writeJsonFile(keyPath, publisher);
    await writeJsonFile(chainPath, [chainEntry]);
    await writeJsonFile(trustPath, {
      keys: [{ keyId: root.keyId, publicKey: root.publicKey }],
    });
    await runCli(["sign", bundlePath, "--key", keyPath, "--chain", chainPath], captureIo());

    const io = captureIo();
    const code = await runCli(["verify", bundlePath, "--trust-root", trustPath], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain(`signature valid (keyId: ${publisher.keyId})`);
  });

  it("passes verify on an unsigned bundle without --require-signature", async () => {
    const bundlePath = join(dir, "agent.afps");
    await writeBundleFile(bundlePath);
    const io = captureIo();
    const code = await runCli(["verify", bundlePath], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("no signature.sig");
  });

  it("fails verify on an unsigned bundle with --require-signature", async () => {
    const bundlePath = join(dir, "agent.afps");
    await writeBundleFile(bundlePath);
    const io = captureIo();
    const code = await runCli(["verify", bundlePath, "--require-signature"], io);
    expect(code).toBe(3);
    expect(io.stderrText()).toContain("no signature.sig");
  });

  it("fails verify when the bundle's manifest is invalid", async () => {
    const bundlePath = join(dir, "agent.afps");
    // Scoped name (required by the Bundle reader) but invalid
    // schemaVersion pattern — validateBundle surfaces this as
    // MANIFEST_SCHEMA.
    await writeBundleFile(bundlePath, {
      manifest: {
        name: "@acme/bad",
        version: "1.0.0",
        type: "agent",
        schemaVersion: "9.0",
        displayName: "Bad",
        author: "tester",
      },
    });
    const io = captureIo();
    const code = await runCli(["verify", bundlePath], io);
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("validation issue");
  });
});
